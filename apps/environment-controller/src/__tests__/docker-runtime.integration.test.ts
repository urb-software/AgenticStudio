import type { OperationPayload } from '@agentic-studio/contracts';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DesiredStates } from '../desired-state.js';
import { DockerComposeRuntime } from '../docker-compose-runtime.js';
import { OperationFailure } from '../failure.js';
import { FakeRuntime } from '../fake-runtime.js';
import { PreviewOperations } from '../preview-operations.js';
import { NodeProcessRunner } from '../process-runner.js';
import { NodeProxyBridges } from '../socket-bridge.js';
import { chunked, directory, file, tar } from './fixtures/tar-builder.js';

// The Docker Compose runtime on the CI runner's system Docker. Slices and egress rules are the
// fake and the bridge is the Node.js one (the container address is reachable from the host).
// A rootless daemon is not exercised: that is a manual run on a disposable VM.

const docker = (args: string[], input?: string) =>
  spawnSync('docker', args, { encoding: 'utf8', input });
const available = process.platform === 'linux' && docker(['info']).status === 0;

if (process.env.CI && !available) {
  throw new Error('The real-daemon tests need Docker on the CI runner, and it is not reachable.');
}

const OWNER = 'io.agentic-studio.owner=environment-controller';
const projectLabel = (id: string) => `io.agentic-studio.project=${id}`;
const identityOf = (projectId: string) => {
  const hex = projectId.replaceAll('-', '');
  return {
    projectId,
    composeProject: `preview-${hex}`,
    previewLabel: `preview-${hex.slice(0, 12)}`,
  };
};

const COMPOSE = `services:
  web:
    build:
      context: ./app
    environment:
      - TOKEN_CHECK=\${STUDIO_CONTROLLER_TOKEN}
      - GREETING=\${APP_GREETING}
    volumes:
      - data:/data
      - /anonymous
    expose:
      - "3000"
volumes:
  data:
`;
const DOCKERFILE =
  'FROM busybox:1.37\nCOPY index.html /www/index.html\nCMD ["httpd", "-f", "-p", "3000", "-h", "/www"]\n';

const sourceArchive = (extra: Buffer[] = []) =>
  tar(
    directory('app/'),
    file('compose.yaml', COMPOSE),
    file('app/Dockerfile', DOCKERFILE),
    file('app/index.html', 'preview-ok\n'),
    // A source .env and an override file that Compose must never read.
    file('.env', 'APP_GREETING=from-the-source-dotenv\nCOMPOSE_PROJECT_NAME=hijacked\n'),
    file(
      'compose.override.yaml',
      'services:\n  evil:\n    image: busybox:1.37\n    command: ["sleep", "300"]\n',
    ),
    ...extra,
  );

function get(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/', method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

interface Inspected {
  Config: { Env: string[]; Labels: Record<string, string> };
  HostConfig: { RestartPolicy: { Name: string }; CgroupParent: string };
}

const inspect = (kind: string, id: string) =>
  JSON.parse(docker([kind, 'inspect', id]).stdout) as Inspected[];
const ids = (args: string[]) =>
  docker(args)
    .stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

describe.skipIf(!available)('Docker Compose runtime on a real daemon', () => {
  let dataDir: string;
  let proxyDir: string;
  let runtime: DockerComposeRuntime;
  let bridges: NodeProxyBridges;
  let operations: PreviewOperations;
  const created = { containers: [] as string[], networks: [] as string[], volumes: [] as string[] };
  const projects: string[] = [];

  const build = (projectId: string, overrides: Record<string, unknown> = {}): OperationPayload =>
    ({
      kind: 'build',
      operationId: randomUUID(),
      ...identityOf(projectId),
      commit: 'c'.repeat(40),
      composeFile: 'compose.yaml',
      service: 'web',
      port: 3000,
      environmentFile: { path: 'preview.env', content: 'APP_GREETING=from-the-environment-file\n' },
      limits: { memoryMiB: 1024, cpuPercent: 100, tasksMax: 512, buildMinutes: 20 },
      ...overrides,
    }) as OperationPayload;

  const simple = (kind: 'stop' | 'remove_data' | 'state', projectId: string): OperationPayload =>
    ({ kind, operationId: randomUUID(), ...identityOf(projectId) }) as OperationPayload;

  function operationsFor(archive: Buffer, deadlineMs?: (minutes: number) => number) {
    const fake = new FakeRuntime();
    return new PreviewOperations({
      dataDir,
      minFreeBytes: 1,
      killGraceMs: 2000,
      compose: {
        PATH: process.env.PATH ?? '/usr/bin',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        XDG_RUNTIME_DIR: dataDir,
      },
      fetchSource: async () => ({ stream: chunked(archive, 64 * 1024), length: archive.length }),
      runtime,
      slices: fake,
      egress: fake,
      desired: new DesiredStates(dataDir),
      deadlineMs,
    });
  }

  const context = () => ({ signal: new AbortController().signal, log: () => undefined });

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'controller-docker-'));
    proxyDir = join(dataDir, 'proxy');
    mkdirSync(proxyDir);
    bridges = new NodeProxyBridges({ dir: proxyDir, proxyGid: process.getgid?.() ?? 0 });
    runtime = new DockerComposeRuntime({
      runner: new NodeProcessRunner(),
      bridges,
      dataDir,
      path: process.env.PATH ?? '/usr/bin',
      dockerHost: 'unix:///var/run/docker.sock',
      xdgRuntimeDir: dataDir,
    });
    operations = operationsFor(sourceArchive());
  });

  afterAll(async () => {
    await runtime?.close();
    for (const projectId of projects) {
      const identity = identityOf(projectId);
      const call = { signal: AbortSignal.timeout(120_000), onLine: () => undefined };
      await runtime?.removeContainers(identity, call).catch(() => undefined);
      await runtime?.removeVolumes(identity, call).catch(() => undefined);
    }
    if (created.containers.length) docker(['rm', '-f', '-v', ...created.containers]);
    if (created.networks.length) docker(['network', 'rm', ...created.networks]);
    if (created.volumes.length) docker(['volume', 'rm', '-f', ...created.volumes]);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  /** Resources that look like a Preview's but lack a label, or belong to another Project. */
  function createDecoys(projectId: string) {
    const suffix = randomUUID().slice(0, 8);
    const names = {
      unlabelled: `decoy-plain-${suffix}`,
      ownerOnly: `decoy-owner-${suffix}`,
      otherProject: `decoy-other-${suffix}`,
      network: `decoy-net-${suffix}`,
      volume: `decoy-vol-${suffix}`,
    };
    docker(['create', '--name', names.unlabelled, 'busybox:1.37', 'sleep', '300']);
    docker(['create', '--name', names.ownerOnly, '--label', OWNER, 'busybox:1.37', 'sleep', '300']);
    docker([
      'create',
      '--name',
      names.otherProject,
      '--label',
      OWNER,
      '--label',
      projectLabel(randomUUID()),
      'busybox:1.37',
      'sleep',
      '300',
    ]);
    docker(['network', 'create', '--label', OWNER, names.network]);
    docker(['volume', 'create', '--label', OWNER, names.volume]);
    created.containers.push(names.unlabelled, names.ownerOnly, names.otherProject);
    created.networks.push(names.network);
    created.volumes.push(names.volume);
    expect(projectId).toBeTruthy();
    return names;
  }

  it('builds and starts a Preview: source files ignored, token empty, labels, restart, bridge', async () => {
    const projectId = randomUUID();
    projects.push(projectId);
    const identity = identityOf(projectId);
    const decoys = createDecoys(projectId);
    process.env.STUDIO_CONTROLLER_TOKEN = 'a-fake-controller-token-that-must-not-reach-compose';
    try {
      const outcome = await operations.execute(build(projectId), context());
      expect(outcome.runtime?.services.map((service) => service.name)).toEqual(['web']);
    } finally {
      delete process.env.STUDIO_CONTROLLER_TOKEN;
    }

    const containerIds = ids([
      'ps',
      '--all',
      '--no-trunc',
      '--quiet',
      '--filter',
      `label=${OWNER}`,
      '--filter',
      `label=${projectLabel(projectId)}`,
    ]);
    expect(containerIds).toHaveLength(1);
    const [web] = inspect('container', containerIds[0]!);
    const env = web!.Config.Env as string[];
    // The source `.env` and COMPOSE_PROJECT_NAME were not read; the Environment file was.
    expect(env).toContain('GREETING=from-the-environment-file');
    expect(env).toContain('TOKEN_CHECK=');
    expect(env.join('\n')).not.toContain('a-fake-controller-token');
    expect(web!.Config.Labels['com.docker.compose.project']).toBe(identity.composeProject);
    expect(web!.Config.Labels['io.agentic-studio.owner']).toBe('environment-controller');
    expect(web!.Config.Labels['io.agentic-studio.project']).toBe(projectId);
    expect(web!.HostConfig.RestartPolicy.Name).toBe('no');
    expect(web!.HostConfig.CgroupParent).toBe(`${identity.composeProject}.slice`);
    // The override file was not loaded either: no `evil` service exists.
    expect(
      docker([
        'ps',
        '--all',
        '--filter',
        'label=com.docker.compose.service=evil',
        '--quiet',
      ]).stdout.trim(),
    ).toBe('');

    expect(
      ids([
        'network',
        'ls',
        '--quiet',
        '--filter',
        `label=${OWNER}`,
        '--filter',
        `label=${projectLabel(projectId)}`,
      ]),
    ).toHaveLength(1);
    expect(
      ids([
        'volume',
        'ls',
        '--quiet',
        '--filter',
        `label=${OWNER}`,
        '--filter',
        `label=${projectLabel(projectId)}`,
      ]),
    ).toHaveLength(1);

    // The bridge serves an HTTP request through the Preview socket.
    expect(await get(join(proxyDir, `${identity.previewLabel}.sock`))).toBe('preview-ok\n');

    // Stop: labelled containers, anonymous volumes and networks go; the named volume stays.
    await operations.execute(simple('stop', projectId), context());
    expect(existsSync(join(proxyDir, `${identity.previewLabel}.sock`))).toBe(false);
    expect(ids(['ps', '--all', '--quiet', '--filter', `label=${projectLabel(projectId)}`])).toEqual(
      [],
    );
    expect(
      ids(['network', 'ls', '--quiet', '--filter', `label=${projectLabel(projectId)}`]),
    ).toEqual([]);
    const volumesAfterStop = ids([
      'volume',
      'ls',
      '--quiet',
      '--filter',
      `label=${projectLabel(projectId)}`,
    ]);
    expect(volumesAfterStop).toHaveLength(1);

    // Unlabelled resources, the owner-only one and another Project's survive the stop.
    for (const name of [decoys.unlabelled, decoys.ownerOnly, decoys.otherProject]) {
      expect(inspect('container', name)).toHaveLength(1);
    }
    expect(inspect('network', decoys.network)).toHaveLength(1);
    expect(inspect('volume', decoys.volume)).toHaveLength(1);

    // remove_data takes the labelled volume too, and still nothing else.
    await operations.execute(simple('remove_data', projectId), context());
    expect(
      ids(['volume', 'ls', '--quiet', '--filter', `label=${projectLabel(projectId)}`]),
    ).toEqual([]);
    for (const name of [decoys.unlabelled, decoys.ownerOnly, decoys.otherProject]) {
      expect(inspect('container', name)).toHaveLength(1);
    }
    expect(inspect('volume', decoys.volume)).toHaveLength(1);
    expect(inspect('network', decoys.network)).toHaveLength(1);
  }, 600_000);

  it('reports the state of a stopped Project as empty', async () => {
    const projectId = randomUUID();
    const outcome = await operations.execute(simple('state', projectId), context());
    expect(outcome.runtime).toEqual({ services: [] });
  });

  it('kills a build at its deadline and reports build_timed_out', async () => {
    const projectId = randomUUID();
    projects.push(projectId);
    const slow = tar(
      directory('app/'),
      file(
        'compose.yaml',
        'services:\n  web:\n    build:\n      context: ./app\n    expose: ["3000"]\n',
      ),
      file('app/Dockerfile', 'FROM busybox:1.37\nRUN sleep 600\n'),
    );
    const timed = operationsFor(slow, () => 8000);
    const started = Date.now();
    const failure = await timed
      .execute(build(projectId, { environmentFile: null }), context())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OperationFailure);
    expect(failure).toMatchObject({ code: 'build_timed_out' });
    expect(Date.now() - started).toBeLessThan(90_000);
    const compose = spawnSync(
      'pgrep',
      ['-f', '--', `--project-name ${identityOf(projectId).composeProject}`],
      {
        encoding: 'utf8',
      },
    );
    expect(compose.stdout.trim()).toBe('');
  }, 180_000);
});
