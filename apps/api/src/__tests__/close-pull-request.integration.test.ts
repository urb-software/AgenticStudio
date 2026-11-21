import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MergeCredential } from '../platform/config/merge-credential.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import { WITHOUT_QUEUE_WORKERS } from './test-config.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// Closing a Run's pull request from Studio over HTTP on the real app (PostgreSQL and Redis via
// Testcontainers), with a recording fake of the Git host and the worker's side driven over its
// routes.

// Throwaway credentials generated per run; none is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const MERGE_TOKEN = randomBytes(24).toString('hex');
const WORKER = randomUUID();
const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
const LIMITS = { stepMinutes: 60, maxSteps: 5, waitingDays: 14, maxTotalSteps: 20 };
const PROBLEM = {
  runActive: 'urn:agentic-studio:problem:close-run-active',
  hostRefused: 'urn:agentic-studio:problem:close-host-refused',
};

type FakeHost = NonNullable<
  NonNullable<NonNullable<Parameters<typeof startStudioApp>[1]>['executions']>['mergeHost']
>;

/** A Git host that answers the open pull request, and records what it was asked. */
function fakeHost() {
  const calls: string[] = [];
  const refusals = new Map<string, string>();
  const answer = (method: string) => {
    calls.push(method);
    const message = refusals.get(method);
    return Promise.resolve(
      message === undefined
        ? { ok: true as const }
        : { ok: false as const, failure: { code: 'refused' as const, message } },
    );
  };
  const unused = () => Promise.reject(new Error('not used'));
  const host = {
    readPullRequest: () => {
      calls.push('readPullRequest');
      return Promise.resolve({
        ok: true as const,
        pullRequest: {
          state: 'open' as const,
          draft: true,
          headSha: 'a'.repeat(40),
          headRef: '',
          baseRef: 'dev',
          mergeable: true,
          mergeableState: 'clean',
        },
      });
    },
    readChecks: unused,
    markReady: unused,
    approve: unused,
    merge: unused,
    close: () => answer('close'),
    deleteRunBranch: () => answer('deleteRunBranch'),
  } satisfies FakeHost;
  return { host, calls, refusals };
}

describe('close without merging API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  let cookie: string;
  const git = fakeHost();

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const asWorker = (path: string, body: object) =>
    http().post(`/api/worker/${path}`).set('Authorization', `Bearer ${WORKER_TOKEN}`).send(body);
  const getRun = (runId: string) => http().get(`/api/runs/${runId}`).set('Cookie', cookie);
  const close = (runId: string, headers: object = { Cookie: cookie }) =>
    http()
      .post(`/api/runs/${runId}/pull-request/close`)
      .set({ Origin: STUDIO_ORIGIN, ...headers })
      .send();

  function expectProblem(response: request.Response, status: number, type: string) {
    expect(response.status).toBe(status);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.type).toBe(type);
  }

  /** A Run of a new project carried through one done step to its draft pull request. */
  async function deliveredRun(options: { finish?: boolean } = {}) {
    const name = `Shop ${randomUUID()}`;
    const [project] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    const url = `https://github.com/acme/${project!.id}.git`;
    await db().$executeRaw`
      INSERT INTO repositories
        (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
      VALUES (${project!.id}::uuid, ${url}, ${url.slice(8, -4)}, 'dev', 'ready',
              ${randomBytes(20).toString('hex')}, now())`;
    const started = await http()
      .post(`/api/projects/${project!.id}/runs`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send({ task: 'Add a health check', provider: 'claude_code' });
    expect(started.status).toBe(201);
    const runId = started.body.id as string;
    expect((await asWorker('runs/claim', { workerId: WORKER })).status).toBe(200);
    await asWorker(`runs/${runId}/state`, { workerId: WORKER, state: 'running' });
    if (options.finish === false) return runId;
    const stepped = await asWorker(`runs/${runId}/steps`, {
      workerId: WORKER,
      index: 1,
      kind: 'start',
      result: { outcome: 'done', summary: 'Done.', sessionRef: 'session-1' },
      workingCopy: {
        runBranch: `agent/add-a-health-check-r${runId.slice(0, 8)}`,
        commits: [{ id: 'c'.repeat(40), subject: 'Add GET /health' }],
        hasUncommittedChanges: false,
      },
    });
    expect(stepped.status).toBe(204);
    const ended = await asWorker(`runs/${runId}/state`, {
      workerId: WORKER,
      state: 'succeeded',
      delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
    });
    expect(ended.status).toBe(204);
    return runId;
  }

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(
      {
        ...services.config,
        workerToken: WORKER_TOKEN_DIGEST,
        runLimits: LIMITS,
        mergeCredential: MergeCredential.of(MERGE_TOKEN),
      },
      // No job worker: the Integration branch fetch is scheduled, never run against the network.
      { ...WITHOUT_QUEUE_WORKERS, executions: { mergeHost: git.host } },
    );
    cookie = await signIn(app);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  beforeEach(async () => {
    // Test isolation only; CASCADE also empties runs.
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    git.calls.length = 0;
    git.refusals.clear();
    // The worker reports itself with every poll: Runs can only start once it has.
    const status = await asWorker('status', {
      workerId: WORKER,
      runner: 'cli',
      providers: { claude_code: true, codex: true },
    });
    expect(status.status).toBe(204);
  });

  it('closes the pull request, deletes the branch, and the Run shows both', async () => {
    const runId = await deliveredRun();

    const closed = await close(runId);

    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({
      state: 'closed',
      closedFromStudioAt: expect.any(String),
      runBranchDeletedAt: expect.any(String),
    });
    expect(git.calls).toEqual(['readPullRequest', 'close', 'deleteRunBranch']);
    expect((await getRun(runId)).body.pullRequest).toMatchObject({
      state: 'closed',
      closedFromStudioAt: closed.body.closedFromStudioAt,
      runBranchDeletedAt: closed.body.runBranchDeletedAt,
    });
    // The Clone is asked to catch up with the Integration branch (the Repository record).
    const [repository] = await db().$queryRaw<{ state: string }[]>`
      SELECT state FROM repositories WHERE project_id = ${(await getRun(runId)).body.projectId}::uuid`;
    expect(repository!.state).toBe('fetching');
  });

  it('changes nothing when repeated, and calls no host', async () => {
    const runId = await deliveredRun();
    const first = await close(runId);
    git.calls.length = 0;

    const again = await close(runId);

    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(git.calls).toEqual([]);
  });

  it('keeps the close when the deletion fails, and the same request retries it', async () => {
    const runId = await deliveredRun();
    git.refusals.set('deleteRunBranch', 'Branch is protected.');

    const first = await close(runId);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      state: 'closed',
      runBranchDeletionFailure: 'Branch is protected.',
    });
    expect(first.body).not.toHaveProperty('runBranchDeletedAt');

    git.refusals.clear();
    git.calls.length = 0;
    const retried = await close(runId);

    expect(git.calls).toEqual(['deleteRunBranch']);
    expect(retried.body).toMatchObject({ closedFromStudioAt: first.body.closedFromStudioAt });
    expect(retried.body).toHaveProperty('runBranchDeletedAt');
    expect(retried.body).not.toHaveProperty('runBranchDeletionFailure');
  });

  it('refuses with a distinct reason while the Run is active', async () => {
    const runId = await deliveredRun({ finish: false });

    expectProblem(await close(runId), 409, PROBLEM.runActive);
    expect(git.calls).toEqual([]);
  });

  it('refuses with the host reason, and records nothing as closed', async () => {
    const runId = await deliveredRun();
    git.refusals.set('close', 'Resource not accessible by personal access token.');

    const refused = await close(runId);

    expectProblem(refused, 409, PROBLEM.hostRefused);
    expect(refused.body.detail).toContain('Resource not accessible');
    expect((await getRun(runId)).body.pullRequest).not.toHaveProperty('closedFromStudioAt');
  });

  it('refuses a Run that is unknown', async () => {
    expect((await close(randomUUID())).status).toBe(404);
  });

  it('is an operator route: no session, a foreign origin and the worker token are refused', async () => {
    const runId = await deliveredRun();

    expect((await close(runId, {})).status).toBe(401);
    expect((await close(runId, { Cookie: cookie, Origin: 'https://evil.example' })).status).toBe(
      403,
    );
    const withWorkerToken = await http()
      .post(`/api/runs/${runId}/pull-request/close`)
      .set({ Origin: STUDIO_ORIGIN, Authorization: `Bearer ${WORKER_TOKEN}` })
      .send();
    expect(withWorkerToken.status).toBe(401);
    expect(git.calls).toEqual([]);
  });
});
