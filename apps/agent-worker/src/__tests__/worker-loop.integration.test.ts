import { createDatabaseClient, type DatabaseClient } from '@agentic-studio/database';
import { deployMigrations } from '@agentic-studio/database/migrations';
import { startPostgres, startRedis, type TestService } from '@agentic-studio/testing';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunner } from '../fake-runner.js';
import { StudioApi } from '../studio-api.js';
import { AgentWorker } from '../worker.js';

// Issue #96, the whole backbone: the real worker loop, in process, against the real Studio API
// (its production build, as a separate process) on PostgreSQL and Redis from Testcontainers.
// The worker reaches the API over HTTP only, as in production; the database client here is
// test setup (a project with a ready Repository) and is never handed to the worker.
// The agent worker is Linux-only, so this suite runs on Linux (CI) and skips elsewhere.

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const API_MAIN = join(ROOT, 'apps', 'api', 'dist', 'main.js');
const HASH_PASSWORD = join(ROOT, 'apps', 'api', 'dist', 'platform', 'auth', 'hash-password.js');
const STUDIO_ORIGIN = 'http://localhost:4300';
// Throwaway values generated per run; none is committed.
const OPERATOR_PASSWORD = randomBytes(18).toString('base64');
const WORKER_TOKEN = randomBytes(32).toString('base64');

type RunView = { id: string; state: string; failure?: { code: string; detail: string } };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await delay(100);
  }
}

describe.skipIf(process.platform !== 'linux')('agent worker loop against the real API', () => {
  let postgres: TestService;
  let redis: TestService;
  let db: DatabaseClient;
  let api: ChildProcess;
  let apiUrl: string;
  let cookie: string;
  let dataDir: string;
  const workers: AgentWorker[] = [];

  const logger = { info: () => undefined, error: () => undefined };

  function startWorker(token = WORKER_TOKEN): AgentWorker {
    const worker = new AgentWorker({
      api: new StudioApi({ apiUrl, token, workerId: randomUUID() }),
      runner: new FakeRunner({ slowMs: 60_000 }),
      pollMs: 50,
      heartbeatMs: 200,
      logger,
    });
    workers.push(worker);
    void worker.run();
    return worker;
  }

  async function readyProject(): Promise<string> {
    const name = `Project ${randomUUID()}`;
    const [project] = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    const path = `git.example.test/acme/${project!.id}`;
    await db.$executeRaw`
      INSERT INTO repositories
        (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
      VALUES (${project!.id}::uuid, ${`https://${path}.git`}, ${path}, 'dev', 'ready',
              ${randomBytes(20).toString('hex')}, now())`;
    return project!.id;
  }

  async function startRun(task: string): Promise<string> {
    const response = await fetch(`${apiUrl}/api/projects/${await readyProject()}/runs`, {
      method: 'POST',
      headers: { Origin: STUDIO_ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, provider: 'claude_code' }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as RunView).id;
  }

  async function getRun(runId: string): Promise<RunView> {
    const response = await fetch(`${apiUrl}/api/runs/${runId}`, { headers: { Cookie: cookie } });
    return (await response.json()) as RunView;
  }

  const runReaches = (runId: string, states: string[]) =>
    until(
      () => getRun(runId),
      (run) => states.includes(run.state),
    );

  beforeAll(async () => {
    if (!existsSync(API_MAIN)) {
      throw new Error(
        'Build the API first (pnpm test:agent-worker does): apps/api/dist is missing.',
      );
    }
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    await deployMigrations(postgres.url);
    db = createDatabaseClient(postgres.url);

    const hashed = spawnSync(process.execPath, [HASH_PASSWORD], {
      input: `${OPERATOR_PASSWORD}\n`,
      encoding: 'utf8',
    });
    const passwordHash = hashed.stdout.trim().split(/\r?\n/).pop() ?? '';
    if (hashed.status !== 0 || !passwordHash.startsWith('$argon2id$')) {
      throw new Error(`hash-password failed with exit code ${hashed.status}`);
    }

    dataDir = mkdtempSync(join(tmpdir(), 'studio-worker-it-'));
    const port = await freePort();
    apiUrl = `http://127.0.0.1:${port}`;
    api = spawn(process.execPath, [API_MAIN], {
      cwd: join(ROOT, 'apps', 'api'),
      stdio: ['ignore', 'ignore', 'inherit'],
      env: {
        ...process.env,
        DATABASE_URL: postgres.url,
        REDIS_URL: redis.url,
        API_PORT: String(port),
        API_HOST: '127.0.0.1',
        STUDIO_ORIGIN,
        STUDIO_OPERATOR_PASSWORD_HASH: passwordHash,
        STUDIO_SECRETS_KEY: randomBytes(32).toString('base64'),
        STUDIO_DATA_DIR: dataDir,
        STUDIO_WORKER_TOKEN: WORKER_TOKEN,
      },
    });
    await until(
      () =>
        fetch(`${apiUrl}/api/health`)
          .then((response) => response.status)
          .catch(() => 0),
      (status) => status === 200,
      90_000,
    );

    const login = await fetch(`${apiUrl}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: STUDIO_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: OPERATOR_PASSWORD }),
    });
    const session = login.headers
      .getSetCookie()
      .find((value) => value.startsWith('studio_session='));
    if (login.status !== 200 || !session) throw new Error(`login failed: ${login.status}`);
    cookie = session.split(';')[0]!;
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
    // Test isolation (review of #112): no Run of one test (e.g. one waiting for the operator,
    // which stays active) may hold a server-wide slot in the next. CASCADE empties runs too.
    await db.$executeRaw`TRUNCATE TABLE projects CASCADE`;
  });

  beforeEach(async () => {
    // Guard for the isolation above: every test starts with both server-wide slots free.
    const [row] = await db.$queryRaw<{ active: bigint }[]>`
      SELECT count(*) AS active FROM runs
      WHERE state IN ('preparing', 'running', 'waiting_for_operator')`;
    expect(Number(row?.active)).toBe(0);
  });

  afterAll(async () => {
    if (api && api.exitCode === null) {
      const exited = new Promise((resolve) => api.once('exit', resolve));
      api.kill('SIGTERM');
      await exited;
    }
    await db?.$disconnect();
    await Promise.all([postgres?.stop(), redis?.stop()]);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('carries a Run from start to succeeded through the fake runner', async () => {
    const runId = await startRun('Add a health check');
    startWorker();

    const run = await runReaches(runId, ['succeeded', 'failed']);

    expect(run.state).toBe('succeeded');
    expect(run).not.toHaveProperty('failure');
  });

  it('reports a failing agent as failed with agent_failed', async () => {
    const runId = await startRun('[fake:fail] Break it');
    startWorker();

    const run = await runReaches(runId, ['succeeded', 'failed']);

    expect(run).toMatchObject({
      state: 'failed',
      failure: { code: 'agent_failed', detail: 'The fake agent failed.' },
    });
  });

  it('reports a crashing runner as failed with unknown', async () => {
    const runId = await startRun('[fake:crash]');
    startWorker();

    expect((await runReaches(runId, ['succeeded', 'failed'])).failure?.code).toBe('unknown');
  });

  it('pauses a Run with a question as waiting_for_operator', async () => {
    const runId = await startRun('[fake:question]');
    startWorker();

    expect((await runReaches(runId, ['waiting_for_operator', 'failed'])).state).toBe(
      'waiting_for_operator',
    );
  });

  it('on shutdown reports the Run it carries as failed with worker_lost', async () => {
    const runId = await startRun('[fake:slow]');
    const worker = startWorker();
    await runReaches(runId, ['running']);

    await worker.stop();

    expect(await getRun(runId)).toMatchObject({
      state: 'failed',
      failure: { code: 'worker_lost', detail: 'worker shut down' },
    });
  });

  it('claims nothing with a wrong token: the Run stays queued', async () => {
    const runId = await startRun('Add a health check');
    startWorker(randomBytes(32).toString('base64'));

    await delay(500);

    expect((await getRun(runId)).state).toBe('queued');
  });
});
