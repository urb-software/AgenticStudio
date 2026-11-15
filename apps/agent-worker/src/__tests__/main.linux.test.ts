import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRemote, isolatedGitEnv } from './fixtures/git-fixture.js';

// Issue #96 (review of #112, finding 4): the worker process as it runs, its built main.js,
// against a stub of the worker routes: SIGTERM → stop() → the Run reported failed → exit 0,
// and the refusal to start with Studio-side settings. Linux only, like the worker.

const MAIN = join(import.meta.dirname, '..', '..', 'dist', 'main.js');
// A throwaway token generated per run; none is committed.
const TOKEN = randomBytes(32).toString('base64');
const RUN = {
  runId: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'codex',
  task: '[fake:slow] Take your time',
  // Issue #98: set to a fixture remote (file://) and its commit in beforeAll.
  startCommit: '',
  repository: { remoteUrl: '' },
};

/** The test harness runs the worker with the fake runner (Issue #101); no CLI is spawned. */
const FAKE_MODE = { STUDIO_WORKER_RUNNER: 'fake', STUDIO_WORKER_ENVIRONMENT: 'test' };

type Report = { path: string; body: Record<string, unknown> };

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}

/** The worker routes: one claimable Run, every report recorded; 401 without the token. */
async function stubStudio(
  run: object | null = RUN,
): Promise<{ server: Server; url: string; reports: Report[] }> {
  const reports: Report[] = [];
  let claimed = run === null;
  const server = createServer((request, response) => {
    void readJson(request).then((body) => {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      const path = request.url ?? '';
      if (path === '/api/worker/runs/states') {
        // Studio knows none of the Runs asked about (Issue #98).
        reports.push({ path, body });
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
        return;
      }
      if (path === '/api/worker/runs/claim') {
        if (claimed) {
          response.writeHead(204).end();
          return;
        }
        claimed = true;
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(run));
        return;
      }
      reports.push({ path, body });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, reports };
}

let fixtures: string;
let home: string;

function startWorker(env: Record<string, string>) {
  // A clean environment: nothing of the test runner's leaks in.
  const child = spawn(process.execPath, [MAIN], {
    // A fake `docker` comes first on the PATH: the test never reaches a Docker daemon.
    env: {
      PATH: `${join(fixtures, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: home,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { child, exited, stderr: () => stderr };
}

describe.skipIf(process.platform !== 'linux')('agent worker process (main.js)', () => {
  let stub: Awaited<ReturnType<typeof stubStudio>>;
  let child: ChildProcess | undefined;

  beforeAll(() => {
    if (!existsSync(MAIN)) {
      throw new Error(
        'Build the worker first (pnpm test:agent-worker does): dist/main.js is missing.',
      );
    }
    fixtures = mkdtempSync(join(tmpdir(), 'studio-worker-main-'));
    home = join(fixtures, 'home');
    mkdirSync(home);
    const remote = createRemote(fixtures, 'shop', isolatedGitEnv(home));
    RUN.startCommit = remote.commit('Initial commit', { 'README.md': 'shop' });
    RUN.repository.remoteUrl = remote.url;
    mkdirSync(join(fixtures, 'bin'));
    writeFileSync(
      join(fixtures, 'bin', 'docker'),
      `#!/bin/sh\necho "$*" >> ${join(fixtures, 'docker.log')}\n`,
      { mode: 0o755 },
    );
  });

  afterAll(() => {
    if (fixtures) rmSync(fixtures, { recursive: true, force: true });
  });

  /** The worker's own settings (Issue #98 adds the data directory and the Agent identity). */
  const workerEnv = (
    url: string,
    dataDir = join(fixtures, `data-${randomBytes(4).toString('hex')}`),
  ) => ({
    STUDIO_API_URL: url,
    STUDIO_WORKER_TOKEN: TOKEN,
    STUDIO_WORKER_DATA_DIR: dataDir,
    STUDIO_AGENT_GIT_NAME: 'Studio Agent',
    STUDIO_AGENT_GIT_EMAIL: 'agent@example.test',
  });

  afterEach(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    child = undefined;
    await new Promise((resolve) => stub?.server.close(resolve));
  });

  it('on SIGTERM reports the Run it carries as failed with worker_lost and exits 0', async () => {
    stub = await stubStudio();
    const worker = startWorker({
      ...workerEnv(stub.url),
      STUDIO_WORKER_POLL_MS: '100',
      STUDIO_WORKER_HEARTBEAT_MS: '200',
      ...FAKE_MODE,
      CODEX_CLI_ENABLED: 'true',
    });
    child = worker.child;
    const deadline = Date.now() + 15_000;
    while (!stub.reports.some((report) => report.body.state === 'running')) {
      if (Date.now() > deadline) throw new Error(`no running report; stderr: ${worker.stderr()}`);
      await delay(50);
    }

    worker.child.kill('SIGTERM');

    expect(await worker.exited).toBe(0);
    const states = stub.reports
      .filter((report) => report.path === `/api/worker/runs/${RUN.runId}/state`)
      .map((report) => report.body);
    expect(states.at(-1)).toEqual({
      workerId: expect.any(String),
      state: 'failed',
      failure: { code: 'worker_lost', detail: 'worker shut down' },
      // Issue #98: what the interrupted step left in the Working copy.
      workingCopy: expect.objectContaining({ runBranch: expect.stringMatching(/^agent\//) }),
    });
  });

  it('removes leftover directories without a known Run at start (Issue #98)', async () => {
    stub = await stubStudio(null);
    const dataDir = join(fixtures, 'data-leftovers');
    const leftover = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
    mkdirSync(join(dataDir, 'runs', leftover, 'repo'), { recursive: true });
    mkdirSync(join(dataDir, 'runs', 'not-a-run'));
    const worker = startWorker({ ...workerEnv(stub.url, dataDir), STUDIO_WORKER_POLL_MS: '100' });
    child = worker.child;

    const deadline = Date.now() + 15_000;
    while (readdirSync(join(dataDir, 'runs')).length > 0) {
      if (Date.now() > deadline) throw new Error(`leftovers kept; stderr: ${worker.stderr()}`);
      await delay(50);
    }

    expect(stub.reports.find((report) => report.path === '/api/worker/runs/states')?.body).toEqual({
      workerId: expect.any(String),
      runIds: [leftover],
    });
    // Its containers, networks and volumes were removed first (through the fake docker).
    expect(readFileSync(join(fixtures, 'docker.log'), 'utf8')).toContain(
      'compose -p studio-run-9d8c7b6a5f4e down --volumes --remove-orphans',
    );
  });

  it('refuses to start with a Studio-side setting, naming it but not its value', async () => {
    stub = await stubStudio();
    const secret = `secret-${randomBytes(8).toString('hex')}`;
    const worker = startWorker({
      ...workerEnv(stub.url),
      DATABASE_URL: `postgresql://studio:${secret}@localhost:5432/studio`,
    });
    child = worker.child;

    expect(await worker.exited).toBe(1);
    expect(worker.stderr()).toContain('DATABASE_URL: is a Studio-side setting');
    expect(worker.stderr()).not.toContain(secret);
    expect(stub.reports).toEqual([]);
  });

  it('reports its runner mode and provider switches to Studio (Issue #101)', async () => {
    stub = await stubStudio();
    const worker = startWorker({
      ...workerEnv(stub.url),
      STUDIO_WORKER_POLL_MS: '100',
      ...FAKE_MODE,
      CLAUDE_CODE_ENABLED: 'true',
      CODEX_CLI_ENABLED: 'TRUE',
    });
    child = worker.child;
    const deadline = Date.now() + 15_000;
    while (!stub.reports.some((report) => report.path === '/api/worker/status')) {
      if (Date.now() > deadline) throw new Error(`no status report; stderr: ${worker.stderr()}`);
      await delay(50);
    }

    expect(stub.reports.find((report) => report.path === '/api/worker/status')?.body).toEqual({
      workerId: expect.any(String),
      runner: 'fake',
      providers: { claude_code: true, codex: false },
    });
  });

  it('fails a Run for a disabled provider with provider_disabled (Issue #101)', async () => {
    stub = await stubStudio({ ...RUN, task: 'CODEX_CLI_ENABLED=true', provider: 'codex' });
    const worker = startWorker({
      ...workerEnv(stub.url),
      STUDIO_WORKER_POLL_MS: '100',
      ...FAKE_MODE,
      CLAUDE_CODE_ENABLED: 'true',
    });
    child = worker.child;
    const statePath = `/api/worker/runs/${RUN.runId}/state`;
    const deadline = Date.now() + 15_000;
    while (!stub.reports.some((r) => r.path === statePath && r.body.state === 'failed')) {
      if (Date.now() > deadline) throw new Error(`no failed report; stderr: ${worker.stderr()}`);
      await delay(50);
    }

    expect(stub.reports.filter((r) => r.path === statePath).map((r) => r.body)).toEqual([
      { workerId: expect.any(String), state: 'running' },
      {
        workerId: expect.any(String),
        state: 'failed',
        failure: {
          code: 'provider_disabled',
          detail: expect.stringContaining('Codex is switched off'),
        },
        // Issue #98: the Working copy was prepared, so its (unchanged) state goes with it.
        workingCopy: expect.objectContaining({ commits: [] }),
      },
    ]);
  });

  it.each([
    ['in production', { STUDIO_WORKER_ENVIRONMENT: 'production' }],
    ['without an environment (production by default)', {}],
  ])('refuses to start with the fake runner %s (Issue #101)', async (_case, environment) => {
    stub = await stubStudio();
    const worker = startWorker({
      ...workerEnv(stub.url),
      STUDIO_WORKER_RUNNER: 'fake',
      ...environment,
    });
    child = worker.child;

    expect(await worker.exited).toBe(1);
    expect(worker.stderr()).toContain('STUDIO_WORKER_RUNNER: fake is allowed only when');
    expect(stub.reports).toEqual([]);
  });
});
