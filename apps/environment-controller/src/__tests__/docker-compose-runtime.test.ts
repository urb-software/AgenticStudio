import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DockerComposeRuntime } from '../docker-compose-runtime.js';
import { OperationAborted, OperationFailure } from '../failure.js';
import { buildLayout } from '../layout.js';
import type { PreviewRun, RuntimeCall } from '../ports.js';
import { RecordingBridges } from '../socket-bridge.js';
import { type Call, RecordingRunner } from './fixtures/recording-runner.js';

const adminDir = mkdtempSync(join(tmpdir(), 'controller-admin-'));
afterAll(() => rmSync(adminDir, { recursive: true, force: true }));

const PROJECT = '8f14e45f-ceea-467a-9575-1a3a8b1c0f10';
const OTHER_PROJECT = '11111111-2222-4333-8444-555555555555';
const OPERATION = '0b6f2d1e-7a52-4c90-8e1d-3f6a9b2c4d55';
const COMPOSE_PROJECT = 'preview-8f14e45fceea467a95751a3a8b1c0f10';
const LABEL = 'preview-8f14e45fceea';
const OWNER = 'io.agentic-studio.owner=environment-controller';
const PROJECT_LABEL = `io.agentic-studio.project=${PROJECT}`;

const layout = buildLayout('/data', PROJECT, OPERATION);
const run: PreviewRun = {
  projectId: PROJECT,
  composeProject: COMPOSE_PROJECT,
  previewLabel: LABEL,
  layout,
  environment: { PATH: '/usr/bin', HOME: layout.homeDir, DB_PASSWORD: 'pw-for-the-test-only' },
  service: 'web',
  port: 3000,
};

const lines: [string, string][] = [];
const call = (signal = new AbortController().signal): RuntimeCall => ({
  signal,
  onLine: (stream, line) => lines.push([stream, line]),
  killGraceMs: 1234,
});

const ownedLabels = {
  'io.agentic-studio.owner': 'environment-controller',
  'io.agentic-studio.project': PROJECT,
};

function daemon(world: {
  containers?: object[];
  networks?: object[];
  volumes?: object[];
  failing?: (call: Call) => boolean;
}) {
  return new RecordingRunner((c) => {
    if (world.failing?.(c)) return { exitCode: 1 };
    const [first, second] = c.args;
    const ids = (items: object[] = [], key: string) =>
      items.map((item) => (item as Record<string, string>)[key]).join('\n');
    if (first === 'ps') return { stdout: ids(world.containers, 'Id') };
    if (first === 'network' && second === 'ls') return { stdout: ids(world.networks, 'Id') };
    if (first === 'volume' && second === 'ls') return { stdout: ids(world.volumes, 'Name') };
    if (second === 'inspect') {
      const items =
        first === 'container'
          ? world.containers
          : first === 'network'
            ? world.networks
            : world.volumes;
      return { stdout: JSON.stringify(items ?? []) };
    }
    return {};
  });
}

const container = (id: string, labels: Record<string, string>, extra: object = {}) => ({
  Id: id,
  Name: `/${id}`,
  Config: { Labels: labels },
  State: { Status: 'running', Running: true },
  NetworkSettings: { Networks: { net: { IPAddress: '172.20.0.5' } } },
  ...extra,
});

function runtime(runner: RecordingRunner, bridges = new RecordingBridges()) {
  return {
    bridges,
    runtime: new DockerComposeRuntime({
      runner,
      bridges,
      dataDir: adminDir,
      path: '/usr/bin',
      dockerHost: 'unix:///run/user/2002/docker.sock',
      xdgRuntimeDir: '/run/user/2002',
    }),
  };
}

describe('Compose invocation', () => {
  it('builds with the exact argument array and exactly the given environment', async () => {
    const runner = daemon({});
    await runtime(runner).runtime.build(run, call());
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      binary: 'docker',
      env: run.environment,
      graceMs: 1234,
    });
    expect(runner.argsOf(0)).toEqual([
      'compose',
      '--ansi',
      'never',
      '--progress',
      'plain',
      '--project-name',
      COMPOSE_PROJECT,
      '--project-directory',
      layout.srcDir,
      '--env-file',
      layout.emptyEnvFile,
      '-f',
      layout.stackFile,
      '-f',
      layout.overrideFile,
      'build',
    ]);
  });

  it('never takes a Compose file or an environment from the source tree', async () => {
    const runner = daemon({});
    await runtime(runner).runtime.build(run, call());
    const args = runner.argsOf(0);
    expect(args.filter((arg) => arg === '-f')).toHaveLength(2);
    expect(args).not.toContain('--file');
    expect(args.filter((_, i) => args[i - 1] === '-f')).toEqual([
      layout.stackFile,
      layout.overrideFile,
    ]);
    expect(args[args.indexOf('--env-file') + 1]).toBe(layout.emptyEnvFile);
    expect(Object.keys(runner.calls[0]!.env)).not.toContain('COMPOSE_FILE');
  });

  it('passes build output lines to the build stream', async () => {
    lines.length = 0;
    const runner = new RecordingRunner((_c, emit) => emit('Step 1/3'));
    await runtime(runner).runtime.build(run, call());
    expect(lines).toContainEqual(['build', 'Step 1/3']);
  });

  it('reports a failing build as build_failed, without the output in the detail', async () => {
    const runner = new RecordingRunner(() => ({
      exitCode: 1,
      stderr: 'secret pw-for-the-test-only',
    }));
    const failure = await runtime(runner)
      .runtime.build(run, call())
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(OperationFailure);
    expect(failure).toMatchObject({ code: 'build_failed' });
    expect((failure as Error).message).not.toContain('pw-for-the-test-only');
  });

  it('turns an interrupted process into an abort and a missing docker into runtime_failed', async () => {
    const aborted = new RecordingRunner(() => ({ exitCode: null, interrupted: 'aborted' }));
    await expect(runtime(aborted).runtime.build(run, call())).rejects.toBeInstanceOf(
      OperationAborted,
    );
    const missing = new RecordingRunner(() => ({ exitCode: null, interrupted: 'missing' }));
    await expect(runtime(missing).runtime.build(run, call())).rejects.toMatchObject({
      code: 'runtime_failed',
    });
  });
});

describe('start', () => {
  const up = [
    'compose',
    '--ansi',
    'never',
    '--progress',
    'plain',
    '--project-name',
    COMPOSE_PROJECT,
    '--project-directory',
    layout.srcDir,
    '--env-file',
    layout.emptyEnvFile,
    '-f',
    layout.stackFile,
    '-f',
    layout.overrideFile,
    'up',
    '--detach',
    '--no-build',
    '--remove-orphans',
    '--pull',
    'missing',
  ];

  it('runs up --no-build, finds the entry container by both labels and creates the bridge', async () => {
    const runner = daemon({
      containers: [
        container('c-web', {
          ...ownedLabels,
          'com.docker.compose.service': 'web',
          'com.docker.compose.project': COMPOSE_PROJECT,
        }),
        container('c-db', {
          ...ownedLabels,
          'com.docker.compose.service': 'db',
          'com.docker.compose.project': COMPOSE_PROJECT,
        }),
      ],
    });
    const { runtime: docker, bridges } = runtime(runner);
    await docker.start(run, call());
    expect(runner.argsOf(0)).toEqual(up);
    expect(runner.argsOf(1)).toEqual([
      'ps',
      '--all',
      '--no-trunc',
      '--quiet',
      '--filter',
      `label=${OWNER}`,
      '--filter',
      `label=${PROJECT_LABEL}`,
    ]);
    expect(bridges.events).toEqual([{ event: 'create', previewLabel: LABEL }]);
  });

  it('fails with start_failed when up fails or the entry service is not running', async () => {
    const failing = daemon({ failing: (c) => c.args.includes('up') });
    await expect(runtime(failing).runtime.start(run, call())).rejects.toMatchObject({
      code: 'start_failed',
    });
    const noEntry = daemon({
      containers: [
        container('c-db', {
          ...ownedLabels,
          'com.docker.compose.service': 'db',
          'com.docker.compose.project': COMPOSE_PROJECT,
        }),
      ],
    });
    const { runtime: docker, bridges } = runtime(noEntry);
    await expect(docker.start(run, call())).rejects.toMatchObject({ code: 'start_failed' });
    expect(bridges.events).toEqual([]);
  });

  it('does not take a container of another Compose project for the entry service', async () => {
    const runner = daemon({
      containers: [
        container('c-web', {
          ...ownedLabels,
          'com.docker.compose.service': 'web',
          'com.docker.compose.project': 'other',
        }),
      ],
    });
    await expect(runtime(runner).runtime.start(run, call())).rejects.toMatchObject({
      code: 'start_failed',
    });
  });
});

describe('ownership', () => {
  it('removes only resources with both labels, by explicit id', async () => {
    const runner = daemon({
      containers: [
        container('mine-1', ownedLabels),
        container('only-owner', { 'io.agentic-studio.owner': 'environment-controller' }),
        container('other-project', { ...ownedLabels, 'io.agentic-studio.project': OTHER_PROJECT }),
        container('none', {}),
      ],
      networks: [
        { Id: 'net-mine', Labels: ownedLabels },
        { Id: 'net-unlabelled', Labels: null },
      ],
    });
    const { runtime: docker, bridges } = runtime(runner);
    await bridges.create({ previewLabel: LABEL, address: 'a', port: 1, containerId: 'x' });
    await docker.removeContainers(run, call());

    const removals = runner.calls.filter(
      (c) => c.args[0] === 'rm' || (c.args[0] === 'network' && c.args[1] === 'rm'),
    );
    expect(removals.map((c) => [...c.args])).toEqual([
      ['rm', '--force', '--volumes', 'mine-1'],
      ['network', 'rm', 'net-mine'],
    ]);
    expect(bridges.events.at(-1)).toEqual({ event: 'remove', previewLabel: LABEL });
    const listing = runner.calls.find((c) => c.args[0] === 'ps')!;
    expect(listing.args).toContain(`label=${OWNER}`);
    expect(listing.args).toContain(`label=${PROJECT_LABEL}`);
  });

  it('removes labelled volumes only in removeVolumes, never in removeContainers', async () => {
    const world = {
      volumes: [
        { Name: 'vol-mine', Labels: ownedLabels },
        { Name: 'vol-unlabelled', Labels: {} },
      ],
    };
    const first = daemon(world);
    await runtime(first).runtime.removeContainers(run, call());
    expect(first.calls.some((c) => c.args[0] === 'volume')).toBe(false);

    const second = daemon(world);
    await runtime(second).runtime.removeVolumes(run, call());
    expect(
      second.calls
        .filter((c) => c.args[0] === 'volume' && c.args[1] === 'rm')
        .map((c) => [...c.args]),
    ).toEqual([['volume', 'rm', 'vol-mine']]);
  });

  it('removes nothing and runs no removal when nothing is labelled', async () => {
    const runner = daemon({});
    await runtime(runner).runtime.removeContainers(run, call());
    expect(
      runner.calls.every(
        (c) => c.args[0] === 'ps' || (c.args[0] === 'network' && c.args[1] === 'ls'),
      ),
    ).toBe(true);
  });

  it('gives every Docker call an empty HOME, its own DOCKER_CONFIG and nothing else', async () => {
    const runner = daemon({});
    await runtime(runner).runtime.removeContainers(run, call());
    for (const c of runner.calls) {
      expect(Object.keys(c.env).sort()).toEqual([
        'DOCKER_CONFIG',
        'DOCKER_HOST',
        'HOME',
        'PATH',
        'XDG_RUNTIME_DIR',
      ]);
      expect(c.env.DOCKER_HOST).toBe('unix:///run/user/2002/docker.sock');
    }
  });

  it('reports the state of the labelled containers', async () => {
    const runner = daemon({
      containers: [
        container(
          'a',
          { ...ownedLabels, 'com.docker.compose.service': 'web' },
          { State: { Status: 'running', Running: true } },
        ),
        container(
          'b',
          { ...ownedLabels, 'com.docker.compose.service': 'db' },
          { State: { Status: 'exited', Running: false } },
        ),
        container('c', {}),
      ],
    });
    expect(await runtime(runner).runtime.state(run, call())).toEqual({
      services: [
        { name: 'web', state: 'running' },
        { name: 'db', state: 'exited' },
      ],
    });
  });
});
