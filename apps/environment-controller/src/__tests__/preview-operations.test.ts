import { CONTROLLER_PROBLEM_TYPES, type OperationPayload } from '@agentic-studio/contracts';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DesiredStates } from '../desired-state.js';
import { OperationAborted, OperationFailure } from '../failure.js';
import { FakeRuntime, type FakeRuntimeOptions } from '../fake-runtime.js';
import { buildLayout } from '../layout.js';
import type { PreviewSlices } from '../ports.js';
import { PreviewOperations, type PreviewOperationsDeps } from '../preview-operations.js';
import { StudioApiError } from '../studio-api.js';
import { chunked, directory, file, tar } from './fixtures/tar-builder.js';

const PROJECT = '8f14e45f-ceea-467a-9575-1a3a8b1c0f10';
const COMPOSE_PROJECT = 'preview-8f14e45fceea467a95751a3a8b1c0f10';
const LABEL = 'preview-8f14e45fceea';
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n    ports: ["3000"]\n';
const PASSWORD = 'pw-only-for-this-test';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'controller-ops-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

let counter = 0;
const operationId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

function build(overrides: Partial<Extract<OperationPayload, { kind: 'build' }>> = {}) {
  return {
    kind: 'build',
    operationId: operationId(),
    projectId: PROJECT,
    composeProject: COMPOSE_PROJECT,
    previewLabel: LABEL,
    commit: 'a'.repeat(40),
    composeFile: 'compose.yaml',
    service: 'web',
    port: 3000,
    environmentFile: {
      path: '.env',
      content: `DB_PASSWORD=${PASSWORD}\nCOMPOSE_FILE=/etc/passwd\n`,
    },
    limits: { memoryMiB: 1024, cpuPercent: 100, tasksMax: 512, buildMinutes: 20 },
    ...overrides,
  } as Extract<OperationPayload, { kind: 'build' }>;
}

const other = (kind: 'stop' | 'remove_data' | 'state'): OperationPayload => ({
  kind,
  operationId: operationId(),
  projectId: PROJECT,
  composeProject: COMPOSE_PROJECT,
  previewLabel: LABEL,
});

const goodTar = () =>
  tar(directory('src/'), file('compose.yaml', COMPOSE), file('src/app.js', '1'));

interface Setup {
  fake?: FakeRuntime;
  fakeOptions?: FakeRuntimeOptions;
  archive?: Buffer | (() => Promise<never>);
  slices?: PreviewSlices;
  deps?: Partial<PreviewOperationsDeps>;
}

function setup(options: Setup = {}) {
  const fake = options.fake ?? new FakeRuntime(options.fakeOptions);
  const logged: [string, string][] = [];
  const ops = new PreviewOperations({
    dataDir,
    minFreeBytes: 1,
    killGraceMs: 10,
    compose: {
      PATH: '/usr/bin',
      DOCKER_HOST: 'unix:///run/user/2002/docker.sock',
      XDG_RUNTIME_DIR: '/run/user/2002',
    },
    fetchSource: async () => {
      if (typeof options.archive === 'function') return options.archive();
      const data = options.archive ?? goodTar();
      return { stream: chunked(data), length: data.length };
    },
    runtime: fake,
    slices: options.slices ?? fake,
    egress: fake,
    desired: new DesiredStates(dataDir),
    ...options.deps,
  });
  const context = (signal = new AbortController().signal) => ({
    signal,
    log: (stream: string, text: string) => void logged.push([stream, text]),
  });
  return { fake, ops, logged, context };
}

const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
};

describe('build', () => {
  it('extracts, validates, applies the slice, verifies twice, builds, starts and records the state', async () => {
    const { fake, ops, context } = setup();
    const op = build();
    const outcome = await ops.execute(op, context() as never);

    expect(fake.events).toEqual([
      `slice.apply ${COMPOSE_PROJECT}`,
      `slice.bound ${COMPOSE_PROJECT}`,
      'egress.verify',
      `build ${COMPOSE_PROJECT}`,
      'egress.verify',
      `start ${COMPOSE_PROJECT}`,
      `state ${COMPOSE_PROJECT}`,
    ]);
    expect(outcome.runtime).toEqual({ services: [{ name: 'web', state: 'running' }] });
    expect(fake.limits[0]).toEqual(op.limits);
    expect(fake.bounds[0]).toEqual(op.limits);
    expect(fake.bridges.open).toEqual([LABEL]);

    const layout = buildLayout(dataDir, PROJECT, op.operationId);
    expect(readFileSync(join(layout.srcDir, 'src/app.js'), 'utf8')).toBe('1');
    expect(readFileSync(join(layout.srcDir, '.env'), 'utf8')).toContain(`DB_PASSWORD=${PASSWORD}`);
    expect(existsSync(layout.stackFile)).toBe(true);
    expect(readFileSync(layout.overrideFile, 'utf8')).toContain('cgroup_parent');
    expect(readFileSync(layout.emptyEnvFile, 'utf8')).toBe('');
    // Published ports are removed by the validation; the serialised stack is what Compose gets.
    expect(readFileSync(layout.stackFile, 'utf8')).not.toContain('ports');
    if (process.platform !== 'win32') {
      expect(statSync(join(layout.srcDir, '.env')).mode & 0o777).toBe(0o600);
      expect(statSync(layout.previewRoot).mode & 0o777).toBe(0o700);
    }
    expect(await new DesiredStates(dataDir).list()).toMatchObject([
      { projectId: PROJECT, operationId: op.operationId, service: 'web', port: 3000 },
    ]);
  });

  it('gives Compose the Environment file values on a fixed base, and says which keys it dropped', async () => {
    const { fake, ops, logged, context } = setup();
    await ops.execute(build(), context() as never);
    const env = fake.environments[0]!;
    expect(env.DB_PASSWORD).toBe(PASSWORD);
    expect(env).not.toHaveProperty('COMPOSE_FILE');
    expect(Object.keys(env).sort()).toEqual([
      'DB_PASSWORD',
      'DOCKER_CONFIG',
      'DOCKER_HOST',
      'HOME',
      'PATH',
      'XDG_RUNTIME_DIR',
    ]);
    expect(logged).toContainEqual([
      'controller',
      'Environment file keys not passed on: COMPOSE_FILE.',
    ]);
    expect(JSON.stringify(logged.filter(([stream]) => stream === 'controller'))).not.toContain(
      PASSWORD,
    );
  });

  it('works without an Environment file', async () => {
    const { fake, ops, context } = setup();
    await ops.execute(build({ environmentFile: null }), context() as never);
    expect(Object.keys(fake.environments[0]!)).not.toContain('DB_PASSWORD');
  });

  it('removes the older build directories once the new build runs', async () => {
    const { ops, context } = setup();
    const first = build();
    const second = build();
    await ops.execute(first, context() as never);
    await ops.execute(second, context() as never);
    const builds = readdirSync(join(dataDir, 'previews', PROJECT, 'builds'));
    expect(builds).toEqual([second.operationId]);
  });

  it('refuses a stack the validation refuses, with its refusals, and builds nothing', async () => {
    const bad = tar(
      file('compose.yaml', 'services:\n  web:\n    image: x\n    privileged: true\n'),
    );
    const { fake, ops, context } = setup({ archive: bad });
    const op = build();
    const failure = await failureOf(ops.execute(op, context() as never));
    expect(failure).toBeInstanceOf(OperationFailure);
    expect(failure).toMatchObject({ code: 'validation_refused' });
    const refusals = (failure as OperationFailure).refusals!;
    expect(refusals[0]).toEqual({
      code: 'privileged',
      place: expect.stringContaining('web'),
      message: expect.any(String),
    });
    expect(Object.keys(refusals[0]!).sort()).toEqual(['code', 'message', 'place']);
    expect(fake.events).toEqual([]);
    expect(existsSync(buildLayout(dataDir, PROJECT, op.operationId).buildDir)).toBe(false);
  });

  it('refuses a missing Compose file, an escaping path and an oversized file', async () => {
    const missing = await failureOf(
      setup({ archive: tar(file('other.yaml', COMPOSE)) }).ops.execute(
        build(),
        setup().context() as never,
      ),
    );
    expect(missing).toMatchObject({ code: 'compose_file_missing' });
    const escaping = await failureOf(
      setup().ops.execute(build({ composeFile: '../outside.yaml' }), setup().context() as never),
    );
    expect(escaping).toMatchObject({ code: 'compose_file_missing' });
    const big = tar(file('compose.yaml', `services: {}\n# ${'x'.repeat(300 * 1024)}\n`));
    const oversized = await failureOf(
      setup({ archive: big }).ops.execute(build(), setup().context() as never),
    );
    expect(oversized).toMatchObject({ code: 'validation_refused' });
    expect((oversized as OperationFailure).refusals![0]!.code).toBe('compose_file_too_large');
  });

  it('refuses an Environment file at a tracked path and leaves the tracked file alone', async () => {
    const tracked = tar(file('compose.yaml', COMPOSE), file('.env', 'TRACKED=1\n'));
    const { fake, ops, context } = setup({ archive: tracked });
    const op = build();
    expect(await failureOf(ops.execute(op, context() as never))).toMatchObject({
      code: 'environment_file_tracked',
    });
    expect(fake.events).toEqual([]);
  });

  it('reports an invalid archive as archive_invalid', async () => {
    const evil = tar(file('compose.yaml', COMPOSE), file('../escape.txt', 'x'));
    const { ops, context } = setup({ archive: evil });
    expect(await failureOf(ops.execute(build(), context() as never))).toMatchObject({
      code: 'archive_invalid',
    });
    expect(existsSync(join(dataDir, 'escape.txt'))).toBe(false);
  });

  it('reports too little free disk space as disk_full before it unpacks anything', async () => {
    let fetched = false;
    const { ops, context } = setup({
      deps: {
        freeBytes: async () => 10,
        minFreeBytes: 1_000,
        fetchSource: async () => {
          fetched = true;
          return { stream: chunked(goodTar()), length: 1 };
        },
      },
    });
    expect(await failureOf(ops.execute(build(), context() as never))).toMatchObject({
      code: 'disk_full',
    });
    expect(fetched).toBe(false);
  });

  it('maps the API answers for the source: unavailable and too large fail, not held means lost', async () => {
    const answer = (status: number, type?: string) => async () => {
      throw new StudioApiError(status, '/source', type);
    };
    for (const type of [
      CONTROLLER_PROBLEM_TYPES.sourceUnavailable,
      CONTROLLER_PROBLEM_TYPES.sourceTooLarge,
    ]) {
      const { ops, context } = setup({ archive: answer(409, type) });
      expect(await failureOf(ops.execute(build(), context() as never))).toMatchObject({
        code: 'source_unavailable',
      });
    }
    const held = setup({ archive: answer(409, CONTROLLER_PROBLEM_TYPES.operationNotHeld) });
    expect(await failureOf(held.ops.execute(build(), held.context() as never))).toBeInstanceOf(
      StudioApiError,
    );
    const gone = setup({ archive: answer(404) });
    expect(await failureOf(gone.ops.execute(build(), gone.context() as never))).toBeInstanceOf(
      StudioApiError,
    );
  });

  it('fails with egress_rules_missing before the build, and keeps the previous Preview', async () => {
    const first = setup();
    const previous = build();
    await first.ops.execute(previous, first.context() as never);
    const { fake, ops, context } = setup({ fakeOptions: { egressMissing: true } });
    const op = build();
    expect(await failureOf(ops.execute(op, context() as never))).toMatchObject({
      code: 'egress_rules_missing',
    });
    expect(fake.events.some((event) => event.startsWith('build'))).toBe(false);
    expect(existsSync(buildLayout(dataDir, PROJECT, op.operationId).buildDir)).toBe(false);
    expect(existsSync(buildLayout(dataDir, PROJECT, previous.operationId).buildDir)).toBe(true);
    expect(await new DesiredStates(dataDir).list()).toMatchObject([
      { operationId: previous.operationId },
    ]);
  });

  it('reports limits_failed when the slice cannot be applied', async () => {
    const slices: PreviewSlices = {
      apply: async () => {
        throw new OperationFailure('limits_failed', 'systemd could not reload the slice.');
      },
      boundBuild: async () => undefined,
      remove: async () => undefined,
    };
    const { fake, ops, context } = setup({ slices });
    expect(await failureOf(ops.execute(build(), context() as never))).toMatchObject({
      code: 'limits_failed',
    });
    expect(fake.events).toEqual([]);
  });

  it('reports limits_failed when the build cannot be bounded, and builds nothing', async () => {
    const fake = new FakeRuntime();
    const slices: PreviewSlices = {
      apply: fake.apply.bind(fake),
      boundBuild: async () => {
        throw new OperationFailure('limits_failed', 'systemd could not bound the build.');
      },
      remove: fake.remove.bind(fake),
    };
    const { ops, context } = setup({ fake, slices });
    const op = build();

    expect(await failureOf(ops.execute(op, context() as never))).toMatchObject({
      code: 'limits_failed',
    });
    expect(fake.events).toEqual([`slice.apply ${COMPOSE_PROJECT}`]);
    expect(existsSync(buildLayout(dataDir, PROJECT, op.operationId).buildDir)).toBe(false);
  });

  it('reports build_failed and start_failed from the runtime, and removes the new build directory', async () => {
    const failing = setup({
      fakeOptions: { failBuild: 'The Compose build failed (exit code 1).' },
    });
    const op = build();
    expect(await failureOf(failing.ops.execute(op, failing.context() as never))).toMatchObject({
      code: 'build_failed',
    });
    expect(existsSync(buildLayout(dataDir, PROJECT, op.operationId).buildDir)).toBe(false);
    const starting = setup({ fakeOptions: { failStart: 'no start' } });
    expect(
      await failureOf(starting.ops.execute(build(), starting.context() as never)),
    ).toMatchObject({ code: 'start_failed' });
  });

  it('kills the build at its deadline and reports build_timed_out', async () => {
    const { ops, context, fake } = setup({
      fakeOptions: { buildMs: 60_000 },
      deps: { deadlineMs: () => 50 },
    });
    const op = build();
    const started = Date.now();
    expect(await failureOf(ops.execute(op, context() as never))).toMatchObject({
      code: 'build_timed_out',
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(fake.events).not.toContain(`start ${COMPOSE_PROJECT}`);
    expect(existsSync(buildLayout(dataDir, PROJECT, op.operationId).buildDir)).toBe(false);
  });

  it('counts fetch and extraction in the same deadline', async () => {
    const { ops, context } = setup({
      archive: () => new Promise<never>(() => undefined),
      deps: { deadlineMs: () => 50 },
    });
    expect(await failureOf(ops.execute(build(), context() as never))).toMatchObject({
      code: 'build_timed_out',
    });
  });

  it('aborts from outside without a failure code', async () => {
    const abort = new AbortController();
    const { ops, context } = setup({ fakeOptions: { buildMs: 60_000 } });
    const pending = ops.execute(build(), context(abort.signal) as never);
    setTimeout(() => abort.abort(), 50);
    expect(await failureOf(pending)).toBeInstanceOf(OperationAborted);
  });
});

describe('stop, remove data, state', () => {
  async function running() {
    const world = setup();
    const op = build();
    await world.ops.execute(op, world.context() as never);
    return { ...world, op };
  }

  it('stop removes containers, the slice, the desired state and the build directories, but not the volumes', async () => {
    const { fake, ops, context } = await running();
    fake.events.length = 0;
    await ops.execute(other('stop'), context() as never);
    expect(fake.events).toEqual([
      `removeContainers ${COMPOSE_PROJECT}`,
      `slice.remove ${COMPOSE_PROJECT}`,
    ]);
    expect(fake.bridges.open).toEqual([]);
    expect(await new DesiredStates(dataDir).list()).toEqual([]);
    expect(existsSync(join(dataDir, 'previews', PROJECT, 'builds'))).toBe(false);
  });

  it('remove_data also removes the volumes and the Project directory', async () => {
    const { fake, ops, context } = await running();
    fake.events.length = 0;
    await ops.execute(other('remove_data'), context() as never);
    expect(fake.events).toEqual([
      `removeContainers ${COMPOSE_PROJECT}`,
      `removeVolumes ${COMPOSE_PROJECT}`,
      `slice.remove ${COMPOSE_PROJECT}`,
    ]);
    expect(existsSync(join(dataDir, 'previews', PROJECT))).toBe(false);
  });

  it('stop, remove_data and state still run when the egress rules are missing', async () => {
    const fake = new FakeRuntime({ egressMissing: true });
    const { ops, context } = setup({ fake });
    await ops.execute(other('stop'), context() as never);
    await ops.execute(other('remove_data'), context() as never);
    expect(await ops.execute(other('state'), context() as never)).toEqual({
      runtime: { services: [] },
    });
    expect(fake.events).not.toContain('egress.verify');
  });

  it('state reports the labelled containers', async () => {
    const { ops, context } = await running();
    expect(await ops.execute(other('state'), context() as never)).toEqual({
      runtime: { services: [{ name: 'web', state: 'running' }] },
    });
  });
});

describe('resumeRunning', () => {
  it('starts the Previews whose desired state is running, after the egress check', async () => {
    const first = setup();
    const op = build();
    await first.ops.execute(op, first.context() as never);

    const restarted = setup();
    expect(await restarted.ops.resumeRunning(restarted.context() as never)).toEqual({
      resumed: 1,
      failed: 0,
    });
    expect(restarted.fake.events).toEqual(['egress.verify', `start ${COMPOSE_PROJECT}`]);
    expect(restarted.fake.environments).toEqual([]);
    expect(restarted.fake.bridges.open).toEqual([LABEL]);
  });

  it('starts nothing when the egress rules are missing, and verifies nothing when nothing runs', async () => {
    const first = setup();
    await first.ops.execute(build(), first.context() as never);
    const blocked = setup({ fakeOptions: { egressMissing: true } });
    await expect(blocked.ops.resumeRunning(blocked.context() as never)).rejects.toMatchObject({
      code: 'egress_rules_missing',
    });
    expect(blocked.fake.events).toEqual(['egress.verify']);

    rmSync(join(dataDir, 'previews'), { recursive: true, force: true });
    const empty = setup();
    expect(await empty.ops.resumeRunning(empty.context() as never)).toEqual({
      resumed: 0,
      failed: 0,
    });
    expect(empty.fake.events).toEqual([]);
  });

  it('counts a Preview that fails to start and goes on with the next', async () => {
    const first = setup();
    await first.ops.execute(build(), first.context() as never);
    const failing = setup({ fakeOptions: { failStart: 'no' } });
    expect(await failing.ops.resumeRunning(failing.context() as never)).toEqual({
      resumed: 0,
      failed: 1,
    });
  });
});

describe('after a failure past up, and the kept desired state', () => {
  it('removes the containers, the bridge and the desired state when start fails', async () => {
    const first = setup();
    await first.ops.execute(build(), first.context() as never);
    const failing = setup({ fakeOptions: { failStart: 'no start' } });
    expect(await failureOf(failing.ops.execute(build(), failing.context() as never))).toMatchObject(
      {
        code: 'start_failed',
      },
    );
    expect(failing.fake.events).toContain(`removeContainers ${COMPOSE_PROJECT}`);
    expect(failing.fake.bridges.open).toEqual([]);
    expect(await new DesiredStates(dataDir).list()).toEqual([]);
  });

  it('marks the failure previewRemoved when start failed, and not when the build failed first', async () => {
    const starting = setup({ fakeOptions: { failStart: 'no start' } });
    expect(
      await failureOf(starting.ops.execute(build(), starting.context() as never)),
    ).toMatchObject({ code: 'start_failed', previewRemoved: true });

    const building = setup({ fakeOptions: { failBuild: 'exit 1' } });
    expect(
      await failureOf(building.ops.execute(build(), building.context() as never)),
    ).toMatchObject({ code: 'build_failed', previewRemoved: false });
    expect(building.fake.events.some((event) => event.startsWith('removeContainers'))).toBe(false);
  });

  it('marks a failure before up as not removing the Preview, for every earlier failure', async () => {
    for (const fakeOptions of [{ egressMissing: true }, { failBuild: 'x' }]) {
      const { ops, context } = setup({ fakeOptions });
      expect(await failureOf(ops.execute(build(), context() as never))).toMatchObject({
        previewRemoved: false,
      });
    }
    const bad = setup({ archive: tar(file('other.txt', 'x')) });
    expect(await failureOf(bad.ops.execute(build(), bad.context() as never))).toMatchObject({
      code: 'compose_file_missing',
      previewRemoved: false,
    });
  });

  it('marks a controller_stopped during up as previewRemoved', async () => {
    const abort = new AbortController();
    const fake = new FakeRuntime();
    const start = fake.start.bind(fake);
    fake.start = async (run, call) => {
      await start(run, call);
      abort.abort();
      throw new OperationAborted();
    };
    const { ops, context } = setup({ fake });

    const failure = await failureOf(ops.execute(build(), context(abort.signal) as never));

    expect(failure).toBeInstanceOf(OperationAborted);
    expect(failure).toMatchObject({ previewRemoved: true });
  });

  it('keeps only the Environment file path in the desired state, and reads the values again on resume', async () => {
    const first = setup();
    const op = build({
      environmentFile: { path: 'deploy.env', content: `DB_PASSWORD=${PASSWORD}\n` },
    });
    await first.ops.execute(op, first.context() as never);
    const stored = readFileSync(join(dataDir, 'previews', PROJECT, 'desired.json'), 'utf8');
    expect(stored).toContain('deploy.env');
    expect(stored).not.toContain(PASSWORD);

    const restarted = setup();
    await restarted.ops.resumeRunning(restarted.context() as never);
    expect(restarted.fake.startEnvironments[0]!.DB_PASSWORD).toBe(PASSWORD);
  });

  it('counts a Preview whose build copy of the Environment file is gone as failed', async () => {
    const first = setup();
    const op = build();
    await first.ops.execute(op, first.context() as never);
    rmSync(join(buildLayout(dataDir, PROJECT, op.operationId).srcDir, '.env'));
    const restarted = setup();
    expect(await restarted.ops.resumeRunning(restarted.context() as never)).toEqual({
      resumed: 0,
      failed: 1,
    });
  });
});
