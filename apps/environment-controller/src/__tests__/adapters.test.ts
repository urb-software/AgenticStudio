import { PREVIEW_OPERATION_KINDS, type OperationPayload } from '@agentic-studio/contracts';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { checkEgressScript, ScriptEgressRules } from '../egress-rules.js';
import { OperationAborted, OperationFailure } from '../failure.js';
import { FakeRuntime } from '../fake-runtime.js';
import { DesiredStates } from '../desired-state.js';
import { PreviewOperations } from '../preview-operations.js';
import { NodeProxyBridges, NsenterSocatBridges, removeStaleSocket } from '../socket-bridge.js';
import {
  InvalidClaimError,
  isOperationLost,
  isTransient,
  StudioApi,
  StudioApiError,
} from '../studio-api.js';
import { BUILD_DAEMON_HEADROOM_MIB, renderSlice, SystemdSlices } from '../systemd-slices.js';
import { RecordingRunner } from './fixtures/recording-runner.js';

const PROJECT = '8f14e45f-ceea-467a-9575-1a3a8b1c0f10';
const COMPOSE_PROJECT = 'preview-8f14e45fceea467a95751a3a8b1c0f10';
const identity = {
  projectId: PROJECT,
  composeProject: COMPOSE_PROJECT,
  previewLabel: 'preview-8f14e45fceea',
};
const limits = { memoryMiB: 1024, cpuPercent: 100, tasksMax: 512, buildMinutes: 20 };
const signal = new AbortController().signal;
const env = { PATH: '/usr/bin', HOME: '/home/preview', XDG_RUNTIME_DIR: '/run/user/2002' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-adapters-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('operations only', () => {
  it('handles exactly the contract kinds, and nothing takes a command, image or path from the request', async () => {
    expect([...PREVIEW_OPERATION_KINDS].sort()).toEqual(['build', 'remove_data', 'state', 'stop']);
    const fake = new FakeRuntime();
    const operations = new PreviewOperations({
      dataDir: dir,
      minFreeBytes: 1,
      killGraceMs: 1,
      compose: { PATH: '/usr/bin', DOCKER_HOST: 'unix:///x', XDG_RUNTIME_DIR: '/x' },
      fetchSource: async () => {
        throw new Error('not used');
      },
      runtime: fake,
      slices: fake,
      egress: fake,
      desired: new DesiredStates(dir),
    });
    for (const kind of ['stop', 'remove_data', 'state'] as const) {
      const payload = {
        kind,
        operationId: '00000000-0000-4000-8000-000000000001',
        ...identity,
      } as OperationPayload;
      await expect(
        operations.execute(payload, { signal, log: () => undefined }),
      ).resolves.toBeDefined();
    }
    const unknown = {
      ...identity,
      kind: 'run_command',
      command: 'rm -rf /',
    } as unknown as OperationPayload;
    await expect(
      operations.execute(unknown, { signal, log: () => undefined }),
    ).resolves.toBeUndefined();
    expect(fake.events.some((event) => event.includes('rm'))).toBe(false);
  });

  it('starts only docker, systemctl, the egress rules script and nsenter', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'process-runner.ts'), 'utf8');
    expect(/export type ProcessBinary =\s*([^;]+);/.exec(source)?.[1]?.replace(/\s+/g, ' ')).toBe(
      "'docker' | 'systemctl' | 'egress-rules' | 'nsenter'",
    );
  });
});

describe('SystemdSlices', () => {
  it('writes the slice from validated integers and reloads systemd', async () => {
    const runner = new RecordingRunner();
    await new SystemdSlices({ runner, directory: join(dir, 'user'), env }).apply(
      identity,
      limits,
      signal,
    );
    expect(readFileSync(join(dir, 'user', `${COMPOSE_PROJECT}.slice`), 'utf8')).toBe(
      '[Slice]\nMemoryMax=1024M\nMemorySwapMax=0\nCPUQuota=100%\nTasksMax=512\n',
    );
    expect(runner.calls[0]).toMatchObject({
      binary: 'systemctl',
      args: ['--user', 'daemon-reload'],
      env,
    });
  });

  it('refuses limits that are not whole numbers in bounds', () => {
    expect(() => renderSlice({ ...limits, memoryMiB: 1024.5 })).toThrow(OperationFailure);
    expect(() => renderSlice({ ...limits, cpuPercent: 5 })).toThrow(OperationFailure);
    expect(() => renderSlice({ ...limits, tasksMax: Number.NaN })).toThrow(OperationFailure);
    expect(() => renderSlice({ ...limits, memoryMiB: 70_000 })).toThrow(OperationFailure);
  });

  it('reports limits_failed when systemd fails, and removes the slice with the Preview', async () => {
    const failing = new SystemdSlices({
      runner: new RecordingRunner(() => ({ exitCode: 1 })),
      directory: join(dir, 'user'),
      env,
    });
    await expect(failing.apply(identity, limits, signal)).rejects.toMatchObject({
      code: 'limits_failed',
    });
    const runner = new RecordingRunner();
    const slices = new SystemdSlices({ runner, directory: join(dir, 'user'), env });
    await slices.apply(identity, limits, signal);
    await slices.remove(identity, signal);
    expect(readdirSync(join(dir, 'user'))).toEqual([]);
    expect(runner.calls).toHaveLength(2);
  });
});

describe('SystemdSlices.boundBuild', () => {
  const slices = (runner: RecordingRunner) =>
    new SystemdSlices({ runner, directory: join(dir, 'user'), env });

  it('bounds the daemon unit with the memory plus the daemon headroom, no swap and the CPU quota', async () => {
    const runner = new RecordingRunner();

    await slices(runner).boundBuild(identity, limits, signal);

    expect(BUILD_DAEMON_HEADROOM_MIB).toBe(512);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      binary: 'systemctl',
      args: [
        '--user',
        'set-property',
        '--runtime',
        'docker.service',
        'MemoryMax=1536M',
        'MemorySwapMax=0',
        'CPUQuota=100%',
      ],
      env,
    });
  });

  it('uses the limits of the build, and sets no task limit', async () => {
    const runner = new RecordingRunner();

    await slices(runner).boundBuild(
      identity,
      { ...limits, memoryMiB: 4096, cpuPercent: 250, tasksMax: 2048 },
      signal,
    );

    expect(runner.argsOf(0)).toEqual([
      '--user',
      'set-property',
      '--runtime',
      'docker.service',
      'MemoryMax=4608M',
      'MemorySwapMax=0',
      'CPUQuota=250%',
    ]);
    expect(runner.argsOf(0).join(' ')).not.toContain('TasksMax');
  });

  it('writes no slice file and reloads nothing', async () => {
    const runner = new RecordingRunner();

    await slices(runner).boundBuild(identity, limits, signal);

    expect(runner.argsOf(0)).not.toContain('daemon-reload');
    expect(() => readdirSync(join(dir, 'user'))).toThrow();
  });

  it('refuses limits that are not whole numbers in bounds, before it runs anything', async () => {
    const runner = new RecordingRunner();

    for (const bad of [{ memoryMiB: 1024.5 }, { memoryMiB: 70_000 }, { cpuPercent: 5 }]) {
      await expect(
        slices(runner).boundBuild(identity, { ...limits, ...bad }, signal),
      ).rejects.toMatchObject({
        code: 'limits_failed',
      });
    }
    expect(runner.calls).toEqual([]);
  });

  it('reports limits_failed when systemd fails, and aborts when the operation is aborted', async () => {
    await expect(
      slices(new RecordingRunner(() => ({ exitCode: 1 }))).boundBuild(identity, limits, signal),
    ).rejects.toMatchObject({ code: 'limits_failed' });
    await expect(
      slices(new RecordingRunner(() => ({ interrupted: 'aborted' }))).boundBuild(
        identity,
        limits,
        signal,
      ),
    ).rejects.toBeInstanceOf(OperationAborted);
  });
});

describe('ScriptEgressRules', () => {
  const pidFile = () => join(dir, 'child_pid');

  it('runs the script verify inside the daemon namespace with nsenter as the Preview user', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(pidFile(), '5151\n');
    const runner = new RecordingRunner();
    await new ScriptEgressRules({
      runner,
      script: '/usr/local/lib/agentic-studio/preview-egress-rules',
      rootless: true,
      childPidFile: pidFile(),
      env,
    }).verify(signal);
    expect(runner.calls[0]).toMatchObject({ binary: 'nsenter', env });
    expect(runner.argsOf(0)).toEqual([
      '-U',
      '--preserve-credentials',
      '-n',
      '-t',
      '5151',
      '/usr/local/lib/agentic-studio/preview-egress-rules',
      'verify',
    ]);
  });

  it('gives egress_rules_missing for a failed verify, a missing namespace and a missing script', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(pidFile(), '5151');
    for (const result of [
      { exitCode: 1 },
      { exitCode: null, interrupted: 'missing' as const },
      { exitCode: null, interrupted: 'timeout' as const },
    ]) {
      const rules = new ScriptEgressRules({
        runner: new RecordingRunner(() => result),
        script: '/x',
        rootless: true,
        childPidFile: pidFile(),
        env,
      });
      await expect(rules.verify(signal)).rejects.toMatchObject({ code: 'egress_rules_missing' });
    }
    const noPid = new ScriptEgressRules({
      runner: new RecordingRunner(),
      script: '/x',
      rootless: true,
      childPidFile: join(dir, 'absent'),
      env,
    });
    await expect(noPid.verify(signal)).rejects.toMatchObject({ code: 'egress_rules_missing' });
    const aborted = new ScriptEgressRules({
      runner: new RecordingRunner(() => ({ exitCode: null, interrupted: 'aborted' })),
      script: '/x',
      rootless: true,
      childPidFile: pidFile(),
      env,
    });
    await expect(aborted.verify(signal)).rejects.toBeInstanceOf(OperationAborted);
  });

  it('runs the script directly outside a rootless daemon', async () => {
    const runner = new RecordingRunner();
    await new ScriptEgressRules({
      runner,
      script: '/x',
      rootless: false,
      childPidFile: pidFile(),
      env,
    }).verify(signal);
    expect(runner.calls[0]).toMatchObject({ binary: 'egress-rules', args: ['verify'] });
  });
});

describe('NsenterSocatBridges', () => {
  it('starts socat inside the daemon namespace with nsenter, for the entry service only', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const proxyDir = join(dir, 'proxy');
    mkdirSync(proxyDir);
    writeFileSync(join(dir, 'child_pid'), '5151');
    const runner = new RecordingRunner();
    const bridges = new NsenterSocatBridges({
      runner,
      dir: proxyDir,
      proxyGid: 2003,
      childPidFile: join(dir, 'child_pid'),
      env,
    });
    // The socket never appears under the recording runner, so the setup times out after starting socat.
    await expect(
      bridges.create({
        previewLabel: 'preview-8f14e45fceea',
        address: '10.0.3.7',
        port: 3000,
        containerId: 'c1',
      }),
    ).rejects.toBeInstanceOf(OperationFailure);
    expect(runner.started[0]).toMatchObject({ binary: 'nsenter', env });
    expect([...runner.started[0]!.args]).toEqual([
      '-U',
      '--preserve-credentials',
      '-n',
      '-t',
      '5151',
      'socat',
      `UNIX-LISTEN:${join(proxyDir, 'preview-8f14e45fceea.sock')},fork,mode=0660`,
      'TCP:10.0.3.7:3000',
    ]);
  }, 20_000);

  it('fails with runtime_failed when the socket directory is missing', async () => {
    const bridges = new NsenterSocatBridges({
      runner: new RecordingRunner(),
      dir: join(dir, 'missing'),
      proxyGid: 2003,
      childPidFile: join(dir, 'child_pid'),
      env,
    });
    await expect(
      bridges.create({
        previewLabel: 'preview-8f14e45fceea',
        address: '10.0.3.7',
        port: 3000,
        containerId: 'c1',
      }),
    ).rejects.toMatchObject({ code: 'runtime_failed' });
  });

  it('leaves a path that is not a socket alone', async () => {
    const { writeFileSync, existsSync } = await import('node:fs');
    const path = join(dir, 'file.sock');
    writeFileSync(path, 'not a socket');
    await expect(removeStaleSocket(path)).rejects.toMatchObject({ code: 'runtime_failed' });
    expect(existsSync(path)).toBe(true);
    await expect(removeStaleSocket(join(dir, 'absent.sock'))).resolves.toBeUndefined();
  });
});

describe('StudioApi', () => {
  const CONTROLLER_ID = '6f0e4c1a-2b1f-4a3e-9c1a-0d2d9a3b7c11';
  const calls: { url: string; init: RequestInit }[] = [];
  const api = (answer: () => Response) =>
    new StudioApi({
      apiUrl: 'http://api.test',
      token: 'a-fake-token-of-sufficient-length-0123',
      controllerId: CONTROLLER_ID,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return answer();
      }) as unknown as typeof fetch,
    });
  const problem = (status: number, type: string) =>
    new Response(JSON.stringify({ type }), {
      status,
      headers: { 'content-type': 'application/problem+json' },
    });

  it('claims with the token and the controller id, and reads 204 as nothing to do', async () => {
    calls.length = 0;
    expect(await api(() => new Response(null, { status: 204 })).claim()).toBeNull();
    expect(calls[0]!.url).toBe('http://api.test/api/controller/operations/claim');
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(
      'Bearer a-fake-token-of-sufficient-length-0123',
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ controllerId: CONTROLLER_ID });
  });

  it('validates the claim: a payload with a wrong label is an InvalidClaimError carrying the id', async () => {
    const body = {
      kind: 'stop',
      operationId: '00000000-0000-4000-8000-000000000009',
      projectId: PROJECT,
      composeProject: COMPOSE_PROJECT,
      previewLabel: 'preview-nothex',
    };
    const rejected = api(() => Response.json(body)).claim();
    await expect(rejected).rejects.toBeInstanceOf(InvalidClaimError);
    await expect(rejected).rejects.toMatchObject({ operationId: body.operationId });
    const good = await api(() =>
      Response.json({ ...body, previewLabel: identity.previewLabel }),
    ).claim();
    expect(good).toMatchObject({ kind: 'stop' });
  });

  it('reports state and log with the controller id, and reads the problem type of an error', async () => {
    calls.length = 0;
    await api(() => new Response(null, { status: 204 })).reportState('op-1', {
      state: 'in_progress',
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      controllerId: CONTROLLER_ID,
      state: 'in_progress',
    });
    const error = await api(() =>
      problem(409, 'urn:agentic-studio:problem:preview-operation-not-held'),
    )
      .reportState('op-1', { state: 'in_progress' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StudioApiError);
    expect(isOperationLost(error)).toBe(true);
    expect(isTransient(error)).toBe(false);
    expect(isTransient(new StudioApiError(503, '/x'))).toBe(true);
    expect(isOperationLost(new StudioApiError(409, '/x', 'urn:other'))).toBe(false);
    expect((error as Error).message).not.toContain('a-fake-token');
  });

  it('streams the source with the length the API announced', async () => {
    calls.length = 0;
    const download = await api(
      () => new Response('tar-bytes', { headers: { 'content-length': '9' } }),
    ).fetchSource('op-1');
    expect(download.length).toBe(9);
    expect(calls[0]!.url).toBe(
      `http://api.test/api/controller/operations/op-1/source?controllerId=${CONTROLLER_ID}`,
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of download.stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('tar-bytes');
    await expect(
      api(() =>
        problem(409, 'urn:agentic-studio:problem:preview-operation-source-unavailable'),
      ).fetchSource('op-1'),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('the egress rules script check', () => {
  const file =
    (uid: number, mode: number, regular = true) =>
    async () => ({
      uid,
      mode,
      isFile: () => regular,
    });

  it('accepts a root-owned regular file that only root can write', async () => {
    await expect(checkEgressScript('/x', file(0, 0o100755))).resolves.toBeUndefined();
  });

  it('refuses another owner, a group or other writable file, and a missing or irregular path', async () => {
    await expect(checkEgressScript('/x', file(1000, 0o100755))).rejects.toThrow('owned by root');
    await expect(checkEgressScript('/x', file(0, 0o100775))).rejects.toThrow('writable');
    await expect(checkEgressScript('/x', file(0, 0o100757))).rejects.toThrow('writable');
    await expect(checkEgressScript('/x', file(0, 0o120777, false))).rejects.toThrow('regular file');
    await expect(
      checkEgressScript('/x', async () => {
        throw new Error('ENOENT');
      }),
    ).rejects.toThrow('missing');
  });
});

describe('the runtime settings', () => {
  it('refuses the Docker runtime without its Docker settings, instead of using the fake', () => {
    const config = loadConfig({
      STUDIO_API_URL: 'http://127.0.0.1:3001',
      STUDIO_CONTROLLER_TOKEN: 'a-test-token-of-at-least-32-characters-0123456789',
      STUDIO_CONTROLLER_DATA_DIR: '/tmp/controller',
      STUDIO_CONTROLLER_ENVIRONMENT: 'test',
      STUDIO_CONTROLLER_RUNTIME: 'fake',
    });
    expect(() => createRuntime({ ...config, runtime: 'docker' }, new RecordingRunner())).toThrow(
      'Docker settings',
    );
  });
});

describe.skipIf(process.platform !== 'linux')(
  'stale sockets and the Node.js bridge (Linux)',
  () => {
    it('removes a socket of its own and keeps the directory clean when the bridge is removed', async () => {
      const { createServer } = await import('node:net');
      const { existsSync } = await import('node:fs');
      const path = join(dir, 'own.sock');
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(path, resolve));
      server.close();
      await expect(removeStaleSocket(path)).resolves.toBeUndefined();
      expect(existsSync(path)).toBe(false);

      const upstream = createServer((socket) => socket.end('hi'));
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const port = (upstream.address() as { port: number }).port;
      const bridges = new NodeProxyBridges({ dir, proxyGid: process.getgid?.() ?? 0 });
      await bridges.create({
        previewLabel: 'preview-aaaaaaaaaaaa',
        address: '127.0.0.1',
        port,
        containerId: 'c',
      });
      expect(existsSync(join(dir, 'preview-aaaaaaaaaaaa.sock'))).toBe(true);
      await bridges.closeAll();
      expect(existsSync(join(dir, 'preview-aaaaaaaaaaaa.sock'))).toBe(false);
      upstream.close();
    });
  },
);
