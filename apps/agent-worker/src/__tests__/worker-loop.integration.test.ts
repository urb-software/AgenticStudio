import { createDatabaseClient, type DatabaseClient } from '@agentic-studio/database';
import { deployMigrations } from '@agentic-studio/database/migrations';
import { startPostgres, startRedis, type TestService } from '@agentic-studio/testing';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Deliveries } from '../delivery.js';
import { FakeRunner } from '../fake-runner.js';
import type { Runner, RunStep, StartRunStepInput } from '../runner.js';
import { GitRunner } from '../git.js';
import { Retention } from '../retention.js';
import { composeProjectName } from '../run-layout.js';
import type { ProviderSwitches } from '@agentic-studio/contracts';
import { ProviderGate } from '../provider-gate.js';
import { RunnerDispatcher } from '../runner-dispatcher.js';
import { StudioApi } from '../studio-api.js';
import { AgentWorker } from '../worker.js';
import { WorkingCopies } from '../working-copy.js';
import { createRemote, git, isolatedGitEnv } from './fixtures/git-fixture.js';
import { type StubGitHub, startStubGitHub } from './fixtures/stub-github.js';

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
// Issue #102: the Agent account's token of this run, for the stub of GitHub only.
const AGENT_GITHUB_TOKEN = `ghp_${randomBytes(18).toString('hex')}`;

type RunView = {
  id: string;
  state: string;
  cancellation?: { by: string; reason: string };
  failure?: { code: string; detail: string };
  runBranch?: string;
  commits?: { id: string; subject: string }[];
  hasUncommittedChanges?: boolean;
  pullRequest?: { url: string; number: number };
  delivery?: 'none' | 'delivered' | 'failed';
};

const BOTH_ENABLED: ProviderSwitches = { claude_code: true, codex: true };

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
  // Everything the API process writes (Issue #104: the leak test reads it); stderr is also
  // passed on, as before.
  let apiOutput = '';
  let apiUrl: string;
  let cookie: string;
  let dataDir: string;
  // Issue #98: the agent side's data directory and a fixture remote (file://, no network).
  let fixtures: string;
  let workerDataDir: string;
  let gitEnv: Record<string, string>;
  let remoteUrl: string;
  let remoteHead: string;
  let remoteDir: string;
  // Issue #102: a local stub of GitHub's pull request API; nothing reaches real GitHub.
  let github: StubGitHub;
  const workers: AgentWorker[] = [];

  // What the workers log (the leak test reads it).
  const workerLogs: string[] = [];
  const logger = {
    info: (message: string) => void workerLogs.push(message),
    error: (message: string) => void workerLogs.push(message),
  };

  /** The Run's containers (Issue #100): recorded, never the CI host's Docker. */
  const cleanedUp: string[] = [];

  /** The worker as main.ts composes it in fake mode (Issue #101): the gate before the runner. */
  function startWorker(
    token = WORKER_TOKEN,
    providers = BOTH_ENABLED,
    extras: { runner?: Runner; minuteMs?: number; fetch?: typeof fetch } = {},
  ): AgentWorker {
    const gate = new ProviderGate(providers);
    const git = new GitRunner({ env: { PATH: gitEnv.PATH!, HOME: gitEnv.HOME! } });
    const fake = extras.runner ?? new FakeRunner({ slowMs: 60_000, git });
    const worker = new AgentWorker({
      api: new StudioApi({ apiUrl, token, workerId: randomUUID(), fetch: extras.fetch }),
      runner: new RunnerDispatcher(gate, { claude_code: fake, codex: fake }),
      gate,
      resources: { cleanUp: async (project) => void cleanedUp.push(project) },
      killGraceMs: 500,
      minuteMs: extras.minuteMs,
      status: { runner: 'fake', providers: gate.snapshot() },
      workingCopies: new WorkingCopies({
        dataDir: workerDataDir,
        git,
        agentGitName: 'Studio Agent',
        agentGitEmail: 'agent@example.test',
        // The fixture remote is a file:// URL: a test worker.
        allowFileRemotes: true,
        logger,
      }),
      deliveries: new Deliveries({
        dataDir: workerDataDir,
        git,
        agentGitName: 'Studio Agent',
        agentGitEmail: 'agent@example.test',
        allowFileRemotes: true,
        github: { token: AGENT_GITHUB_TOKEN, apiUrl: github.url },
        logger,
      }),
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
    // The Repository is the fixture remote; Studio's own Clone is not needed here.
    await db.$executeRaw`
      INSERT INTO repositories
        (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
      VALUES (${project!.id}::uuid, ${remoteUrl}, ${`fixture/${project!.id}`}, 'main', 'ready',
              ${remoteHead}, now())`;
    return project!.id;
  }

  /** A connected worker's status report, so Studio accepts new Runs (Issue #101). */
  async function announceWorker(providers = BOTH_ENABLED): Promise<void> {
    await new StudioApi({ apiUrl, token: WORKER_TOKEN, workerId: randomUUID() }).reportStatus({
      runner: 'fake',
      providers,
    });
  }

  function requestRun(task: string, projectId: string) {
    return fetch(`${apiUrl}/api/projects/${projectId}/runs`, {
      method: 'POST',
      headers: { Origin: STUDIO_ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, provider: 'claude_code' }),
    });
  }

  async function startRun(task: string): Promise<string> {
    await announceWorker();
    const response = await requestRun(task, await readyProject());
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
    fixtures = mkdtempSync(join(tmpdir(), 'studio-worker-it-git-'));
    mkdirSync(join(fixtures, 'home'));
    gitEnv = isolatedGitEnv(join(fixtures, 'home'));
    // Under acme/: a test worker names a file:// remote by its last two parts (acme/shop).
    const remote = createRemote(join(fixtures, 'acme'), 'shop', gitEnv);
    remoteHead = remote.commit('Initial commit', { 'README.md': '# Shop\n' });
    remoteUrl = remote.url;
    remoteDir = join(fixtures, 'acme', 'shop.git');
    github = await startStubGitHub();
    workerDataDir = join(fixtures, 'worker-data');
    const port = await freePort();
    apiUrl = `http://127.0.0.1:${port}`;
    api = spawn(process.execPath, [API_MAIN], {
      cwd: join(ROOT, 'apps', 'api'),
      stdio: ['ignore', 'pipe', 'pipe'],
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
    api.stdout!.setEncoding('utf8').on('data', (chunk: string) => (apiOutput += chunk));
    api.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      apiOutput += chunk;
      process.stderr.write(chunk);
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
    await github?.close();
    await db?.$disconnect();
    await Promise.all([postgres?.stop(), redis?.stop()]);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (fixtures) rmSync(fixtures, { recursive: true, force: true });
  });

  it('carries a Run from start to succeeded through the fake runner', async () => {
    const runId = await startRun('Add a health check');
    startWorker();

    const run = await runReaches(runId, ['succeeded', 'failed']);

    expect(run.state).toBe('succeeded');
    expect(run).not.toHaveProperty('failure');
    // Issue #102: nothing changed, so nothing was pushed and no pull request opened.
    expect(run.delivery).toBe('none');
    expect(run).not.toHaveProperty('pullRequest');
    // Issue #98: the Working copy's state reaches the operator's Run.
    expect(run).toMatchObject({
      runBranch: `agent/add-a-health-check-r${runId.slice(0, 8)}`,
      commits: [],
      hasUncommittedChanges: false,
    });
  });

  it('records the commit the fake runner makes and delivers it as a draft pull request (Issues #98, #102)', async () => {
    const runId = await startRun('[fake:commit] Add a file');
    startWorker();

    const run = await runReaches(runId, ['succeeded', 'failed']);

    const runBranch = `agent/fake-commit-add-a-file-r${runId.slice(0, 8)}`;
    expect(run).toMatchObject({
      state: 'succeeded',
      runBranch,
      commits: [{ id: expect.stringMatching(/^[0-9a-f]{40}$/), subject: 'Fake change' }],
      hasUncommittedChanges: false,
      delivery: 'delivered',
      pullRequest: { url: expect.stringMatching(/^https:\/\/github\.com\/acme\/shop\/pull\/\d+$/) },
    });
    // The Run branch reached the remote at the reported commit, and a draft pull request
    // against the integration branch was opened as the Agent account.
    expect(git(remoteDir, ['rev-parse', `refs/heads/${runBranch}`], gitEnv)).toBe(
      run.commits?.[0]?.id,
    );
    expect(github.created.at(-1)?.body).toMatchObject({
      head: runBranch,
      base: 'main',
      draft: true,
      title: 'Fake change',
    });
    expect(github.requests.at(-1)?.authorization).toBe(`Bearer ${AGENT_GITHUB_TOKEN}`);
  });

  it('commits what the fake runner leaves uncommitted, then delivers it (Issues #98, #102)', async () => {
    const runId = await startRun('[fake:dirty] Leave a file');
    startWorker();

    expect(await runReaches(runId, ['succeeded', 'failed'])).toMatchObject({
      state: 'succeeded',
      commits: [{ subject: 'agent: The fake agent finished the task.' }],
      hasUncommittedChanges: false,
      delivery: 'delivered',
    });
  });

  it('never commits or pushes the Environment file: the delivered Run branch does not contain it (Issue #104)', async () => {
    await announceWorker();
    const projectId = await readyProject();
    const set = await fetch(`${apiUrl}/api/projects/${projectId}/environment-file`, {
      method: 'PUT',
      headers: { Origin: STUDIO_ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'config/test.env', content: 'A=test-only-value\n' }),
    });
    expect(set.status).toBe(200);
    const started = await requestRun('[fake:dirty] Env file', projectId);
    const runId = ((await started.json()) as RunView).id;
    startWorker();

    const run = await runReaches(runId, ['succeeded', 'failed']);

    expect(run).toMatchObject({ state: 'succeeded', delivery: 'delivered' });
    const runBranch = `agent/fake-dirty-env-file-r${runId.slice(0, 8)}`;
    const pushed = git(
      remoteDir,
      ['ls-tree', '-r', '--name-only', `refs/heads/${runBranch}`],
      gitEnv,
    ).split('\n');
    expect(pushed).toContain('FAKE_CHANGE.md');
    expect(pushed).not.toContain('config/test.env');
  });

  it('fails a delivery GitHub refuses as delivery_failed, and delivers on "Retry delivery" (Issue #102)', async () => {
    const runId = await startRun('[fake:commit] Retry me');
    github.failCreate = 502;
    startWorker();

    const failed = await runReaches(runId, ['succeeded', 'failed']);
    expect(failed).toMatchObject({
      state: 'failed',
      delivery: 'failed',
      failure: { code: 'delivery_failed', detail: expect.stringContaining('GitHub answered 502') },
    });
    const created = github.created.length;

    const retry = await fetch(`${apiUrl}/api/runs/${runId}/retry-delivery`, {
      method: 'POST',
      headers: { Origin: STUDIO_ORIGIN, Cookie: cookie },
    });
    expect(retry.status).toBe(202);

    const delivered = await runReaches(runId, ['succeeded']);
    expect(delivered).toMatchObject({
      delivery: 'delivered',
      pullRequest: { number: expect.any(Number) },
    });
    expect(delivered).not.toHaveProperty('failure');
    expect(github.created.length).toBe(created + 1);
  });

  it('fails a Run whose start commit the remote does not have as preparation_failed (Issue #98)', async () => {
    const runId = await startRun('Add a health check');
    await db.$executeRaw`UPDATE runs SET start_commit = ${'f'.repeat(40)} WHERE id = ${runId}::uuid`;
    startWorker();

    const run = await runReaches(runId, ['succeeded', 'failed']);

    expect(run).toMatchObject({
      state: 'failed',
      failure: {
        code: 'preparation_failed',
        detail: expect.stringContaining("is not in the Project's repository"),
      },
    });
  });

  it("applies the retention rules with the Runs' states from Studio (Issue #98)", async () => {
    const finished = await startRun('Add a health check');
    startWorker();
    await runReaches(finished, ['succeeded']);
    const waiting = await startRun('[fake:question]');
    await runReaches(waiting, ['waiting_for_operator']);
    const leftover = randomUUID();
    mkdirSync(join(workerDataDir, 'runs', leftover, 'repo'), { recursive: true });
    const cleaned: string[] = [];
    const api = new StudioApi({ apiUrl, token: WORKER_TOKEN, workerId: randomUUID() });

    await new Retention({
      dataDir: workerDataDir,
      runStates: (runIds) => api.runStates(runIds),
      resources: { cleanUp: async (name) => void cleaned.push(name) },
      retentionDays: 0,
      maxPerProject: 10,
      now: () => new Date(Date.now() + 1000),
      carrying: () => undefined,
      logger,
    }).sweep();

    const left = readdirSync(join(workerDataDir, 'runs'));
    expect(left).toContain(waiting);
    expect(left).not.toContain(finished);
    expect(left).not.toContain(leftover);
    expect(cleaned).toEqual(
      expect.arrayContaining([composeProjectName(finished), composeProjectName(leftover)]),
    );
    expect(cleaned).not.toContain(composeProjectName(waiting));
  });

  it("forwards the Run's log to Studio, redacted, readable by the operator (Issue #99)", async () => {
    const runId = await startRun('Print a token [fake:secret]');
    startWorker();

    expect((await runReaches(runId, ['succeeded', 'failed'])).state).toBe('succeeded');

    const response = await fetch(`${apiUrl}/api/runs/${runId}/events`, {
      headers: { Cookie: cookie },
    });
    const { events } = (await response.json()) as {
      events: { seq: number; kind: string; text: string }[];
    };
    expect(events.map((event) => event.kind)).toEqual([
      'step_started',
      'message',
      'command',
      'output',
      'step_finished',
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[3]!.text).toBe('••••••[redacted]');
  });

  it('writes the Environment file for the Run, and its content leaks into no response, log or stored event when the agent prints it (Issue #104)', async () => {
    // Throwaway test values generated per run.
    const password = `test-only-pw-${randomBytes(8).toString('hex')}`;
    const apiKey = `test-only-key-${randomBytes(8).toString('hex')}`;
    const content = `DB_PASSWORD=${password}\nexport API_KEY="${apiKey}"\n`;
    const leaked = (text: string) => text.includes(password) || text.includes(apiKey);
    await announceWorker();
    const projectId = await readyProject();
    const set = await fetch(`${apiUrl}/api/projects/${projectId}/environment-file`, {
      method: 'PUT',
      headers: { Origin: STUDIO_ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '.env', content }),
    });
    expect(set.status).toBe(200);
    const started = await requestRun('Print the settings [fake:print-env]', projectId);
    const runId = ((await started.json()) as RunView).id;
    startWorker();

    const run = await runReaches(runId, ['succeeded', 'failed']);

    expect(run.state).toBe('succeeded');
    expect((run as RunView & { environmentFileSupplied: boolean }).environmentFileSupplied).toBe(
      true,
    );
    // The agent side: the file in the Working copy, owner-only, never committed.
    const file = join(workerDataDir, 'runs', runId, 'repo', '.env');
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(run.hasUncommittedChanges).toBe(false);
    // The agent printed it: the log shows the command and the redacted output.
    const read = (path: string) =>
      fetch(`${apiUrl}${path}`, { headers: { Cookie: cookie } }).then((response) =>
        response.text(),
      );
    const eventsText = await read(`/api/runs/${runId}/events`);
    expect(eventsText).toContain('cat .env');
    expect(eventsText).toContain('DB_PASSWORD=••••••[redacted]');
    for (const path of [
      `/api/runs/${runId}`,
      `/api/runs/${runId}/events`,
      `/api/runs/${runId}/events/stream`,
      `/api/runs/${runId}/steps`,
      '/api/runs',
      `/api/projects/${projectId}`,
      `/api/projects/${projectId}/runs`,
      `/api/projects/${projectId}/environment-file`,
    ]) {
      expect(leaked(await read(path)), path).toBe(false);
    }
    const stored = await db.$queryRaw<{ text: string }[]>`
      SELECT text FROM run_events WHERE run_id = ${runId}::uuid
      UNION ALL SELECT result::text FROM run_steps WHERE run_id = ${runId}::uuid`;
    expect(stored.length).toBeGreaterThan(0);
    expect(leaked(stored.map((row) => row.text).join('\n'))).toBe(false);
    expect(leaked(apiOutput)).toBe(false);
    expect(leaked(workerLogs.join('\n'))).toBe(false);
  });

  it('reports a failing agent as failed with agent_failed', async () => {
    const runId = await startRun('[fake:fail] Break it');
    startWorker();

    const run = await runReaches(runId, ['succeeded', 'failed']);

    expect(run).toMatchObject({
      state: 'failed',
      failure: { code: 'agent_failed', detail: 'The fake agent failed.' },
      // Coordinator decision on #98: the failed step's Working copy state is recorded too.
      runBranch: `agent/fake-fail-break-it-r${runId.slice(0, 8)}`,
      commits: [],
      hasUncommittedChanges: false,
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

  // Issue #100: cancel, the time limit and process-tree termination through the real API.
  // Review of #121: Studio applies a report, but its answer never reaches the worker (the
  // connection drops after the commit). The worker sends it again; the real API treats the repeat
  // as a no-op, so the Run still ends succeeded with exactly one stored Run step.
  it('carries a Run through reports whose answers are lost, without a duplicate step', async () => {
    const lost = new Set(['running', 'steps', 'succeeded']);
    const lossy: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = String(input);
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as { state?: string }) : {};
      const label = url.endsWith('/steps') ? 'steps' : url.endsWith('/state') ? body.state : '';
      if (label && lost.delete(label)) throw new TypeError('fetch failed: the answer was lost');
      return response;
    };
    const runId = await startRun('Add a health check');
    startWorker(WORKER_TOKEN, BOTH_ENABLED, { fetch: lossy });

    const run = await runReaches(runId, ['succeeded', 'failed']);

    expect(run.state).toBe('succeeded');
    expect(lost.size).toBe(0);
    const [steps] = await db.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM run_steps WHERE run_id = ${runId}::uuid`;
    expect(steps?.count).toBe(1);
  });

  describe('cancel and time limit (Issue #100)', () => {
    const cancel = (runId: string) =>
      fetch(`${apiUrl}/api/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { Origin: STUDIO_ORIGIN, Cookie: cookie },
      });

    /** A Run step that starts a real process tree in its own group and ignores every stop. */
    class ProcessTreeRunner implements Runner {
      group: number | undefined;

      async *start({ processes }: StartRunStepInput): RunStep {
        // The shell and both children ignore SIGINT: only the SIGKILL after the grace ends them.
        const child = spawn('sh', ['-c', 'trap "" INT; sleep 600 & sleep 600 & wait'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        this.group = child.pid!;
        processes.register(this.group);
        yield { type: 'message', text: 'process tree started' };
        await delay(600_000, undefined, { ref: false });
        return { outcome: 'done', summary: 'never' };
      }

      resume(): RunStep {
        throw new Error('not used');
      }
    }

    const groupAlive = (group: number) => {
      try {
        process.kill(-group, 0);
        return true;
      } catch {
        return false;
      }
    };

    it('cancels a running Run: the step stops, its Run ends cancelled, the log so far is kept', async () => {
      const runId = await startRun('[fake:slow] Work for a long time');
      startWorker();
      await runReaches(runId, ['running']);

      expect((await cancel(runId)).status).toBe(202);

      const run = await runReaches(runId, ['cancelled', 'failed', 'succeeded']);
      expect(run).toMatchObject({ state: 'cancelled', cancellation: { by: 'operator' } });
      // The Working copy is kept for inspection, and its state recorded.
      expect(run.runBranch).toMatch(/^agent\//);
      expect(cleanedUp).toContain(composeProjectName(runId));
    });

    it('terminates the whole process tree of a step that ignores the interrupt', async () => {
      const runId = await startRun('Start a process tree');
      const runner = new ProcessTreeRunner();
      startWorker(WORKER_TOKEN, BOTH_ENABLED, { runner });
      await runReaches(runId, ['running']);
      await until(
        async () => runner.group,
        (group) => group !== undefined,
      );
      expect(groupAlive(runner.group!)).toBe(true);

      await cancel(runId);

      expect((await runReaches(runId, ['cancelled', 'failed'])).state).toBe('cancelled');
      expect(groupAlive(runner.group!)).toBe(false);
    });

    it('stops a step at its time limit: the Run ends timed_out', async () => {
      const runId = await startRun('[fake:slow] Take too long');
      // One minute of the 60-minute default lasts 5 ms here: the limit is 300 ms.
      startWorker(WORKER_TOKEN, BOTH_ENABLED, { minuteMs: 5 });

      expect((await runReaches(runId, ['timed_out', 'failed', 'succeeded'])).state).toBe(
        'timed_out',
      );
    });

    it('cancels a queued Run before any worker claims it', async () => {
      const runId = await startRun('Never started');

      expect((await cancel(runId)).status).toBe(202);
      startWorker();
      await delay(300);

      expect((await getRun(runId)).state).toBe('cancelled');
    });
  });

  it('claims nothing with a wrong token: the Run stays queued', async () => {
    const runId = await startRun('Add a health check');
    startWorker(randomBytes(32).toString('base64'));

    await delay(500);

    expect((await getRun(runId)).state).toBe('queued');
  });

  describe('provider switches (Issue #101)', () => {
    it('fails a Run for a provider switched off on the worker with provider_disabled', async () => {
      // Studio accepted the Run while a worker enabled Claude Code; the worker that claims it
      // has it switched off. The worker's own check is authoritative.
      const runId = await startRun('CLAUDE_CODE_ENABLED=true [fake:success]');
      startWorker(WORKER_TOKEN, { claude_code: false, codex: true });

      const run = await runReaches(runId, ['succeeded', 'failed']);

      expect(run).toMatchObject({
        state: 'failed',
        failure: {
          code: 'provider_disabled',
          detail: expect.stringContaining('Claude Code is switched off on the agent worker.'),
        },
      });
    });

    it('refuses to start a Run for a provider the worker reports switched off, and lists why', async () => {
      startWorker(WORKER_TOKEN, { claude_code: false, codex: true });
      const projectId = await readyProject();
      const providers = () =>
        fetch(`${apiUrl}/api/providers`, { headers: { Cookie: cookie } }).then(
          (response) => response.json() as Promise<{ id: string; reason?: string }[]>,
        );

      const listed = await until(
        providers,
        (list) => list[0]?.reason !== undefined && list[1]?.reason === undefined,
      );
      const refused = await requestRun('Add a health check', projectId);

      expect(listed).toEqual([
        {
          id: 'claude_code',
          name: 'Claude Code',
          available: false,
          reason: 'Switched off on the agent worker',
        },
        { id: 'codex', name: 'Codex', available: true },
      ]);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        type: 'urn:agentic-studio:problem:provider-unavailable',
        detail: 'Switched off on the agent worker',
      });
    });
  });
});
