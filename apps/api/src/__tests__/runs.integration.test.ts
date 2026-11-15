import {
  jsonByteLength,
  RUN_STEP_RESULT_MAX_BYTES,
  WORKING_COPY_REPORT_MAX_BYTES,
} from '@agentic-studio/contracts';
import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';
import { WITHOUT_QUEUE_WORKERS } from './test-config.js';

// Issue #96, main seam: the real app over HTTP with PostgreSQL and Redis from Testcontainers.
// The operator starts and reads Runs; the agent worker's side is driven over the worker routes
// exactly as the worker calls them. A controlled clock drives the lease, so no test waits.
// Lives outside src/modules/ because building the whole app reaches the database client.

// A throwaway worker token generated per run; no token is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const LEASE_SECONDS = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function expectProblem(response: request.Response, status: number, type?: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
  if (type) expect(response.body.type).toBe(type);
}

const PROBLEM = {
  projectNotFound: 'urn:agentic-studio:problem:project-not-found',
  runNotFound: 'urn:agentic-studio:problem:run-not-found',
  repositoryNotReady: 'urn:agentic-studio:problem:repository-not-ready',
  runNotHeld: 'urn:agentic-studio:problem:run-not-held',
  illegalRunTransition: 'urn:agentic-studio:problem:illegal-run-transition',
  providerUnavailable: 'urn:agentic-studio:problem:provider-unavailable',
  deliveryNotRetryable: 'urn:agentic-studio:problem:delivery-not-retryable',
};

const BOTH_ENABLED = { claude_code: true, codex: true };

describe('runs API and worker protocol (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  let cookie: string;
  const clock = { current: new Date(), now: () => clock.current };
  const advance = (seconds: number) => {
    clock.current = new Date(clock.current.getTime() + seconds * 1000);
  };

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());

  /** A project whose Repository is ready at `head` (test setup only: no Git clone needed). */
  async function readyProject(name: string, head = randomBytes(20).toString('hex')) {
    const [project] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    const url = `https://git.example.test/acme/${name.toLowerCase()}.git`;
    await db().$executeRaw`
      INSERT INTO repositories
        (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
      VALUES (${project!.id}::uuid, ${url}, ${url.slice(8, -4)}, 'dev', 'ready', ${head}, now())`;
    return { id: project!.id, head, url };
  }

  const startRun = (projectId: string, body: unknown) =>
    http()
      .post(`/api/projects/${projectId}/runs`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send(body as object);

  async function queuedRun(projectId: string, task = 'Add a health check') {
    const response = await startRun(projectId, { task, provider: 'claude_code' });
    expect(response.status).toBe(201);
    return response.body as { id: string };
  }

  const getRun = (runId: string) => http().get(`/api/runs/${runId}`).set('Cookie', cookie);

  /** A worker route as the agent worker calls it: Bearer token, JSON, no Origin, no cookie. */
  const worker = (path: string, body: object, token: string | null = WORKER_TOKEN) => {
    const call = http().post(`/api/worker/runs/${path}`);
    if (token !== null) call.set('Authorization', `Bearer ${token}`);
    return call.send(body);
  };

  const W1 = randomUUID();
  const W2 = randomUUID();
  const claim = (workerId = W1) => worker('claim', { workerId });
  const report = (runId: string, body: object, workerId = W1) =>
    worker(`${runId}/state`, { workerId, ...body });
  const WORKING_COPY = {
    runBranch: 'agent/add-a-health-check-r0b8e5c2d',
    commits: [{ id: 'c'.repeat(40), subject: 'Add GET /health' }],
    hasUncommittedChanges: false,
  };
  const reportStep = (runId: string, result: object, workerId = W1, workingCopy = WORKING_COPY) =>
    worker(`${runId}/steps`, { workerId, kind: 'start', result, workingCopy });
  const runStates = (runIds: string[], token: string | null = WORKER_TOKEN) =>
    worker('states', { workerId: W1, runIds }, token);
  const heartbeat = (runId: string, workerId = W1) => worker(`${runId}/heartbeat`, { workerId });

  /** `POST /api/worker/status` as the agent worker sends it (Issue #101). */
  const workerStatus = (
    providers: object = BOTH_ENABLED,
    workerId = W1,
    token: string | null = WORKER_TOKEN,
  ) => {
    const call = http().post('/api/worker/status');
    if (token !== null) call.set('Authorization', `Bearer ${token}`);
    return call.send({ workerId, runner: 'cli', providers });
  };
  const providers = () => http().get('/api/providers').set('Cookie', cookie);

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(
      { ...services.config, workerToken: WORKER_TOKEN_DIGEST, workerLeaseSeconds: LEASE_SECONDS },
      { executions: { clock } },
    );
    cookie = await signIn(app);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  beforeEach(async () => {
    // Test isolation only; CASCADE also empties runs and run_steps.
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    clock.current = new Date();
    // A connected agent worker with both providers switched on (Issue #101).
    expect((await workerStatus()).status).toBe(204);
  });

  describe('operator endpoints', () => {
    it('starts a queued Run from the current integration branch commit and reads it back', async () => {
      const project = await readyProject('Shop');

      const created = await startRun(project.id, { task: 'Fix the login bug', provider: 'codex' });

      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        id: expect.stringMatching(UUID),
        projectId: project.id,
        provider: 'codex',
        task: 'Fix the login bug',
        state: 'queued',
        startCommit: project.head,
        createdAt: expect.stringMatching(ISO_8601),
      });
      expect((await getRun(created.body.id)).body).toEqual(created.body);
      const projectRuns = await http()
        .get(`/api/projects/${project.id}/runs`)
        .set('Cookie', cookie);
      expect(projectRuns.status).toBe(200);
      expect(projectRuns.body).toEqual([created.body]);
      expect((await http().get('/api/runs').set('Cookie', cookie)).body).toEqual([created.body]);
    });

    it('lists Runs newest first, all projects or one', async () => {
      const shop = await readyProject('Shop');
      const blog = await readyProject('Blog');
      const first = await queuedRun(shop.id, 'first');
      const second = await queuedRun(blog.id, 'second');
      const third = await queuedRun(shop.id, 'third');

      const all = await http().get('/api/runs').set('Cookie', cookie);
      expect(all.body.map((run: { id: string }) => run.id)).toEqual([
        third.id,
        second.id,
        first.id,
      ]);
      const ofShop = await http().get(`/api/projects/${shop.id}/runs`).set('Cookie', cookie);
      expect(ofShop.body.map((run: { id: string }) => run.id)).toEqual([third.id, first.id]);
    });

    it('trims the Task and accepts 20 000 characters', async () => {
      const project = await readyProject('Shop');

      const trimmed = await startRun(project.id, { task: '  Fix it \n', provider: 'codex' });
      expect(trimmed.body.task).toBe('Fix it');
      const longest = await startRun(project.id, { task: 'x'.repeat(20_000), provider: 'codex' });
      expect(longest.status).toBe(201);
    });

    it.each([
      ['an empty task', { task: '', provider: 'codex' }],
      ['a blank task', { task: '   ', provider: 'codex' }],
      ['a task over 20 000 characters', { task: 'x'.repeat(20_001), provider: 'codex' }],
      ['no task', { provider: 'codex' }],
      ['an unknown provider', { task: 'x', provider: 'gpt' }],
      ['no provider', { task: 'x' }],
      ['an unknown field', { task: 'x', provider: 'codex', model: 'big' }],
    ])('rejects %s with 422 and field errors, starting nothing', async (_case, body) => {
      const project = await readyProject('Shop');

      const response = await startRun(project.id, body);

      expectProblem(response, 422);
      expect(response.body.errors.length).toBeGreaterThan(0);
      expect((await http().get('/api/runs').set('Cookie', cookie)).body).toEqual([]);
    });

    it('rejects an unknown project with 404', async () => {
      expectProblem(
        await startRun(randomUUID(), { task: 'x', provider: 'codex' }),
        404,
        PROBLEM.projectNotFound,
      );
      expectProblem(
        await startRun('not-a-uuid', { task: 'x', provider: 'codex' }),
        404,
        PROBLEM.projectNotFound,
      );
      expectProblem(
        await http().get(`/api/projects/${randomUUID()}/runs`).set('Cookie', cookie),
        404,
        PROBLEM.projectNotFound,
      );
    });

    it('rejects a project without a Repository, or with one that is not ready, with 409', async () => {
      const [bare] = await db().$queryRaw<{ id: string }[]>`
        INSERT INTO projects (name, name_normalized) VALUES ('Bare', 'bare') RETURNING id`;
      const noRepository = await startRun(bare!.id, { task: 'x', provider: 'codex' });
      expectProblem(noRepository, 409, PROBLEM.repositoryNotReady);
      expect(noRepository.body.detail).toBe(
        'The project has no repository. Connect one before starting a run.',
      );

      await db().$executeRaw`
        INSERT INTO repositories (project_id, url, url_normalized, integration_branch, state)
        VALUES (${bare!.id}::uuid, 'https://git.example.test/a/b.git', 'git.example.test/a/b',
                'dev', 'connecting')`;
      const notReady = await startRun(bare!.id, { task: 'x', provider: 'codex' });
      expectProblem(notReady, 409, PROBLEM.repositoryNotReady);
      expect(notReady.body.detail).toMatch(/not ready/);
    });

    it('answers 404 for an unknown Run', async () => {
      expectProblem(await getRun(randomUUID()), 404, PROBLEM.runNotFound);
      expectProblem(await getRun('nope'), 404, PROBLEM.runNotFound);
    });

    it('requires the operator session', async () => {
      expectProblem(await http().get('/api/runs'), 401);
      expectProblem(
        await http()
          .post(`/api/projects/${randomUUID()}/runs`)
          .set('Origin', STUDIO_ORIGIN)
          .send({ task: 'x', provider: 'codex' }),
        401,
      );
    });
  });

  describe('provider availability (Issue #101)', () => {
    const NO_WORKER = 'No agent worker is connected';
    const SWITCHED_OFF = 'Switched off on the agent worker';

    it('lists the providers the connected worker enables', async () => {
      const response = await providers();

      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        { id: 'claude_code', name: 'Claude Code', available: true },
        { id: 'codex', name: 'Codex', available: true },
      ]);
    });

    it('shows a provider switched off on the worker as unavailable and refuses to start it', async () => {
      const project = await readyProject('Shop');
      expect((await workerStatus({ claude_code: true, codex: false })).status).toBe(204);

      expect((await providers()).body).toEqual([
        { id: 'claude_code', name: 'Claude Code', available: true },
        { id: 'codex', name: 'Codex', available: false, reason: SWITCHED_OFF },
      ]);
      const refused = await startRun(project.id, { task: 'x', provider: 'codex' });
      expectProblem(refused, 409, PROBLEM.providerUnavailable);
      expect(refused.body.detail).toBe(SWITCHED_OFF);
      expect((await http().get('/api/runs').set('Cookie', cookie)).body).toEqual([]);
      expect((await startRun(project.id, { task: 'x', provider: 'claude_code' })).status).toBe(201);
    });

    it('takes the latest report: a worker restarted with a provider switched off', async () => {
      const project = await readyProject('Shop');
      expect((await workerStatus({ claude_code: false, codex: true }, W2)).status).toBe(204);

      const refused = await startRun(project.id, { task: 'x', provider: 'claude_code' });

      expectProblem(refused, 409, PROBLEM.providerUnavailable);
      expect(refused.body.detail).toBe(SWITCHED_OFF);
    });

    it('counts a worker silent for longer than the lease as not connected', async () => {
      const project = await readyProject('Shop');
      advance(LEASE_SECONDS);
      expect((await providers()).body.every((p: { available: boolean }) => p.available)).toBe(true);

      advance(1);

      expect((await providers()).body).toEqual([
        { id: 'claude_code', name: 'Claude Code', available: false, reason: NO_WORKER },
        { id: 'codex', name: 'Codex', available: false, reason: NO_WORKER },
      ]);
      const refused = await startRun(project.id, { task: 'x', provider: 'claude_code' });
      expectProblem(refused, 409, PROBLEM.providerUnavailable);
      expect(refused.body.detail).toBe(NO_WORKER);
    });

    it('offers no provider before any worker has reported', async () => {
      const fresh = await startStudioApp(
        { ...services.config, workerToken: WORKER_TOKEN_DIGEST },
        WITHOUT_QUEUE_WORKERS,
      );
      try {
        const response = await request(fresh.getHttpServer())
          .get('/api/providers')
          .set('Cookie', await signIn(fresh));
        expect(response.body).toEqual([
          { id: 'claude_code', name: 'Claude Code', available: false, reason: NO_WORKER },
          { id: 'codex', name: 'Codex', available: false, reason: NO_WORKER },
        ]);
      } finally {
        await fresh.close();
      }
    });

    it('requires the operator session to list providers; the worker token grants nothing', async () => {
      expectProblem(await http().get('/api/providers'), 401);
      expectProblem(
        await http().get('/api/providers').set('Authorization', `Bearer ${WORKER_TOKEN}`),
        401,
      );
    });

    it('accepts status reports with the worker token only', async () => {
      const off = { claude_code: false, codex: false };
      expectProblem(await workerStatus(off, W1, null), 401);
      expectProblem(await workerStatus(off, W1, randomBytes(32).toString('base64')), 401);
      expectProblem(
        await http()
          .post('/api/worker/status')
          .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
          .send({ workerId: W1, runner: 'cli', providers: off }),
        401,
      );

      expect((await providers()).body.every((p: { available: boolean }) => p.available)).toBe(true);
    });

    it('rejects a status report with an unknown runner mode (400)', async () => {
      const response = await http()
        .post('/api/worker/status')
        .set('Authorization', `Bearer ${WORKER_TOKEN}`)
        .send({ workerId: W2, runner: 'api', providers: BOTH_ENABLED });

      expectProblem(response, 400);
    });

    it.each([
      ['a switch sent as text', { claude_code: 'true', codex: true }],
      ['a missing provider', { claude_code: true }],
      ['an unknown provider', { ...BOTH_ENABLED, gpt: true }],
    ])('rejects a status report with %s (400) and keeps the last one', async (_case, body) => {
      await workerStatus({ claude_code: false, codex: false });

      expectProblem(await workerStatus(body), 400);

      expect((await providers()).body.some((p: { available: boolean }) => p.available)).toBe(false);
    });
  });

  describe('worker protocol', () => {
    it('carries a Run from start to succeeded: claim, running, a step result, succeeded', async () => {
      const project = await readyProject('Shop');
      const run = await queuedRun(project.id, 'Add a health check');

      const claimed = await claim();
      expect(claimed.status).toBe(200);
      expect(claimed.body).toEqual({
        runId: run.id,
        projectId: project.id,
        provider: 'claude_code',
        task: 'Add a health check',
        startCommit: project.head,
        // Issue #98: the remote as connected; nothing else about the Repository.
        repository: { remoteUrl: project.url },
        // Issue #102: the pull request's base, and a Run to start (not only to deliver).
        integrationBranch: 'dev',
        kind: 'start',
      });
      const preparing = (await getRun(run.id)).body;
      expect(preparing).toMatchObject({
        state: 'preparing',
        startedAt: clock.current.toISOString(),
      });

      expect((await report(run.id, { state: 'running' })).status).toBe(204);
      const result = {
        outcome: 'done',
        summary: 'Added GET /health.',
        pullRequest: { title: 'Add health check', body: 'Adds GET /health.' },
        checks: [{ name: 'unit tests', result: 'passed' }],
      };
      expect((await reportStep(run.id, result)).status).toBe(204);
      expect((await heartbeat(run.id)).status).toBe(204);
      advance(5);
      expect(
        (await report(run.id, { state: 'succeeded', delivery: { outcome: 'none' } })).status,
      ).toBe(204);

      const finished = (await getRun(run.id)).body;
      expect(finished).toMatchObject({
        state: 'succeeded',
        finishedAt: clock.current.toISOString(),
      });
      expect(finished).not.toHaveProperty('failure');
      // Issue #98: the Working copy state of the latest step, on the operator's Run.
      expect(finished).toMatchObject({
        runBranch: WORKING_COPY.runBranch,
        commits: WORKING_COPY.commits,
        hasUncommittedChanges: false,
      });
      expect((await claim()).status).toBe(204);
      // The step is internal (not in the operator contract yet): checked in the table.
      const steps = await db().$queryRaw<{ index: number; kind: string; result: unknown }[]>`
        SELECT index, kind, result FROM run_steps WHERE run_id = ${run.id}::uuid`;
      expect(steps).toEqual([{ index: 1, kind: 'start', result }]);
    });

    it('shows no Working copy state before the first step, then the latest one (Issue #98)', async () => {
      const project = await readyProject('Shop');
      const run = await queuedRun(project.id);
      await claim();
      await report(run.id, { state: 'running' });
      const before = (await getRun(run.id)).body;
      expect(before).not.toHaveProperty('runBranch');
      expect(before).not.toHaveProperty('commits');
      expect(before).not.toHaveProperty('hasUncommittedChanges');

      await reportStep(run.id, { outcome: 'needs_input', summary: 'Stuck.', question: 'Q?' });
      const later = {
        runBranch: WORKING_COPY.runBranch,
        commits: [...WORKING_COPY.commits, { id: 'd'.repeat(40), subject: 'Fix it' }],
        hasUncommittedChanges: true,
      };
      expect(
        (await reportStep(run.id, { outcome: 'done', summary: 'Done.' }, W1, later)).status,
      ).toBe(204);

      expect((await getRun(run.id)).body).toMatchObject(later);
      expect((await http().get('/api/runs').set('Cookie', cookie)).body[0]).toMatchObject(later);
    });

    it('rejects a step report without a valid Working copy state with 400 (Issue #98)', async () => {
      const project = await readyProject('Shop');
      const run = await queuedRun(project.id);
      await claim();
      await report(run.id, { state: 'running' });
      const result = { outcome: 'done', summary: 'Done.' };

      expectProblem(await worker(`${run.id}/steps`, { workerId: W1, kind: 'start', result }), 400);
      expectProblem(
        await reportStep(run.id, result, W1, {
          ...WORKING_COPY,
          commits: [{ id: 'not-a-commit', subject: 'x' }],
        }),
        400,
      );
      expect((await getRun(run.id)).body).not.toHaveProperty('runBranch');
    });

    it('answers the states of known Runs for the retention, leaving out unknown ids (Issue #98)', async () => {
      const project = await readyProject('Shop');
      const finished = await queuedRun(project.id, 'first');
      const queued = await queuedRun(project.id, 'second');
      await claim();
      await report(finished.id, {
        state: 'failed',
        failure: { code: 'preparation_failed', detail: 'x' },
      });
      const unknown = randomUUID();

      const response = await runStates([finished.id, queued.id, unknown]);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(response.body).toEqual(
        expect.arrayContaining([
          { runId: finished.id, state: 'failed', finishedAt: clock.current.toISOString() },
          { runId: queued.id, state: 'queued', finishedAt: null },
        ]),
      );
      expectProblem(await runStates([finished.id], null), 401);
      expectProblem(
        await http()
          .post('/api/worker/runs/states')
          .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
          .send({ workerId: W1, runIds: [finished.id] }),
        401,
      );
      expectProblem(await runStates([]), 400);
      expectProblem(await runStates(['../../etc']), 400);
    });

    describe('delivery (Issue #102)', () => {
      const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
      const DONE = { outcome: 'done', summary: 'Added GET /health.' };

      /** A Run carried to the end of its step by W1. */
      async function steppedRun(result: object = DONE) {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await report(run.id, { state: 'running' });
        expect((await reportStep(run.id, result)).status).toBe(204);
        return run;
      }

      /** A Run whose delivery failed. */
      async function failedDelivery() {
        const run = await steppedRun();
        const failed = await report(run.id, {
          state: 'failed',
          failure: { code: 'delivery_failed', detail: 'Pushing the Run branch was refused.' },
        });
        expect(failed.status).toBe(204);
        return run;
      }

      const retryDelivery = (runId: string) =>
        http()
          .post(`/api/runs/${runId}/retry-delivery`)
          .set({ Origin: STUDIO_ORIGIN, Cookie: cookie });

      it('records the draft pull request of a delivered Run on the Run and in the lists', async () => {
        const run = await steppedRun();

        const reported = await report(run.id, {
          state: 'succeeded',
          delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
        });

        expect(reported.status).toBe(204);
        const delivered = (await getRun(run.id)).body;
        expect(delivered).toMatchObject({
          state: 'succeeded',
          delivery: 'delivered',
          pullRequest: PULL_REQUEST,
        });
        expect(delivered).not.toHaveProperty('deliveryRetryRequested');
        const listed = (await http().get('/api/runs').set('Cookie', cookie)).body as object[];
        expect(listed[0]).toMatchObject({ delivery: 'delivered', pullRequest: PULL_REQUEST });
      });

      it('records "No changes" as the delivery none, without a pull request', async () => {
        const run = await steppedRun();

        await report(run.id, { state: 'succeeded', delivery: { outcome: 'none' } });

        const finished = (await getRun(run.id)).body;
        expect(finished).toMatchObject({ state: 'succeeded', delivery: 'none' });
        expect(finished).not.toHaveProperty('pullRequest');
      });

      it('shows the checks the agent reported failed', async () => {
        const run = await steppedRun({
          ...DONE,
          checks: [
            { name: 'lint', result: 'passed' },
            { name: 'unit tests', result: 'failed' },
          ],
        });

        expect((await getRun(run.id)).body).toMatchObject({ failingChecks: ['unit tests'] });
      });

      it('rejects a delivery outcome with any state but succeeded (400)', async () => {
        const run = await steppedRun();

        const response = await report(run.id, {
          state: 'failed',
          failure: { code: 'delivery_failed', detail: 'x' },
          delivery: { outcome: 'none' },
        });

        expectProblem(response, 400);
      });

      it('retries a failed delivery: 202, a delivery claim, then succeeded with the pull request', async () => {
        const run = await failedDelivery();
        expect((await getRun(run.id)).body).toMatchObject({ state: 'failed', delivery: 'failed' });

        const requested = await retryDelivery(run.id);
        expect(requested.status).toBe(202);
        expect(requested.body).toMatchObject({
          id: run.id,
          state: 'failed',
          deliveryRetryRequested: true,
        });
        expect((await retryDelivery(run.id)).status).toBe(202);

        const claimed = await claim(W2);
        expect(claimed.status).toBe(200);
        expect(claimed.body).toMatchObject({ runId: run.id, kind: 'deliver' });
        expect((await claim()).status).toBe(204);
        expect((await heartbeat(run.id, W2)).status).toBe(204);
        advance(5);

        const reported = await report(
          run.id,
          {
            state: 'succeeded',
            delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
            workingCopy: WORKING_COPY,
          },
          W2,
        );
        expect(reported.status).toBe(204);
        const delivered = (await getRun(run.id)).body;
        expect(delivered).toMatchObject({
          state: 'succeeded',
          delivery: 'delivered',
          pullRequest: PULL_REQUEST,
          finishedAt: clock.current.toISOString(),
        });
        expect(delivered).not.toHaveProperty('failure');
        expect(delivered).not.toHaveProperty('deliveryRetryRequested');
      });

      it('keeps a Run failed with the new reason when its delivery retry fails again', async () => {
        const run = await failedDelivery();
        await retryDelivery(run.id);
        await claim(W2);

        await report(
          run.id,
          { state: 'failed', failure: { code: 'delivery_failed', detail: 'GitHub answered 503.' } },
          W2,
        );

        expect((await getRun(run.id)).body).toMatchObject({
          state: 'failed',
          delivery: 'failed',
          failure: { code: 'delivery_failed', detail: 'GitHub answered 503.' },
        });
        expect((await retryDelivery(run.id)).status).toBe(202);
      });

      it('keeps a delivery retry whose worker was lost a failed delivery', async () => {
        const run = await failedDelivery();
        await retryDelivery(run.id);
        await claim(W2);
        advance(LEASE_SECONDS + 1);

        expect((await claim()).status).toBe(204);

        expect((await getRun(run.id)).body).toMatchObject({
          state: 'failed',
          delivery: 'failed',
          failure: { code: 'delivery_failed' },
        });
        expect((await getRun(run.id)).body).not.toHaveProperty('deliveryRetryRequested');
      });

      it('counts a held delivery retry toward the limits: its project and the server', async () => {
        const run = await failedDelivery();
        const [{ projectId }] = await db().$queryRaw<{ projectId: string }[]>`
          SELECT project_id AS "projectId" FROM runs WHERE id = ${run.id}::uuid`;
        await retryDelivery(run.id);
        expect((await claim(W2)).body).toMatchObject({ runId: run.id, kind: 'deliver' });
        const sameProject = await queuedRun(projectId!);
        const other = await queuedRun((await readyProject('Other')).id);
        const third = await queuedRun((await readyProject('Third')).id);

        expect((await claim()).body).toMatchObject({ runId: other.id });
        expect((await claim()).status).toBe(204);
        expect((await getRun(sameProject.id)).body.state).toBe('queued');
        expect((await getRun(third.id)).body.state).toBe('queued');
      });

      it('refuses a retry for a Run whose delivery did not fail (409) and an unknown Run (404)', async () => {
        const project = await readyProject('Shop');
        const queued = await queuedRun(project.id);
        const succeeded = await steppedRun();
        await report(succeeded.id, { state: 'succeeded', delivery: { outcome: 'none' } });
        const agentFailed = await queuedRun((await readyProject('Other')).id);
        await claim();
        await report(agentFailed.id, { state: 'running' });
        await report(agentFailed.id, {
          state: 'failed',
          failure: { code: 'agent_failed', detail: 'exit 1' },
        });

        expectProblem(await retryDelivery(queued.id), 409, PROBLEM.deliveryNotRetryable);
        expectProblem(await retryDelivery(succeeded.id), 409, PROBLEM.deliveryNotRetryable);
        expectProblem(await retryDelivery(agentFailed.id), 409, PROBLEM.deliveryNotRetryable);
        expect((await getRun(agentFailed.id)).body).not.toHaveProperty('deliveryRetryRequested');
        expectProblem(await retryDelivery(randomUUID()), 404, PROBLEM.runNotFound);
        expectProblem(await retryDelivery('nope'), 404, PROBLEM.runNotFound);
      });

      it('requires the operator session and the Studio origin to retry', async () => {
        const run = await failedDelivery();

        const anonymous = await http()
          .post(`/api/runs/${run.id}/retry-delivery`)
          .set('Origin', STUDIO_ORIGIN);
        expect(anonymous.status).toBe(401);
        const foreign = await http()
          .post(`/api/runs/${run.id}/retry-delivery`)
          .set({ Origin: 'https://evil.example.test', Cookie: cookie });
        expect(foreign.status).toBe(403);
        const withWorkerToken = await http()
          .post(`/api/runs/${run.id}/retry-delivery`)
          .set({ Origin: STUDIO_ORIGIN, Authorization: `Bearer ${WORKER_TOKEN}` });
        expect(withWorkerToken.status).toBe(401);
        expect((await getRun(run.id)).body).not.toHaveProperty('deliveryRetryRequested');
      });
    });

    it('records a failed Run with its failure code and detail', async () => {
      const project = await readyProject('Shop');
      const run = await queuedRun(project.id);
      await claim();
      await report(run.id, { state: 'running' });

      const failed = await report(run.id, {
        state: 'failed',
        failure: { code: 'agent_failed', detail: 'The agent exited with code 1.' },
      });

      expect(failed.status).toBe(204);
      expect((await getRun(run.id)).body).toMatchObject({
        state: 'failed',
        failure: { code: 'agent_failed', detail: 'The agent exited with code 1.' },
        finishedAt: expect.stringMatching(ISO_8601),
      });
    });

    it('accepts a step result of the maximum size within the JSON body limit (review finding 4)', async () => {
      const project = await readyProject('Shop');
      const run = await queuedRun(project.id);
      await claim();
      await report(run.id, { state: 'running' });
      const result = {
        outcome: 'done',
        summary: 's'.repeat(20_000),
        pullRequest: { title: 't'.repeat(256), body: 'b'.repeat(65_536) },
        checks: [] as { name: string; result: string; detail: string }[],
      };
      for (;;) {
        const check = { name: 'check', result: 'passed', detail: '' };
        result.checks.push(check);
        const room = RUN_STEP_RESULT_MAX_BYTES - jsonByteLength(result);
        check.detail = 'd'.repeat(Math.min(room, 4000));
        if (room <= 4000) break;
      }
      expect(jsonByteLength(result)).toBe(RUN_STEP_RESULT_MAX_BYTES);
      // Issue #98: with a Working copy report near its own cap, the body is over Express's
      // default 100 KiB and still accepted.
      const workingCopy = {
        runBranch: WORKING_COPY.runBranch,
        commits: Array.from({ length: 200 }, () => ({
          id: 'c'.repeat(64),
          subject: 's'.repeat(200),
        })),
        hasUncommittedChanges: true,
      };
      expect(jsonByteLength(workingCopy)).toBeLessThanOrEqual(WORKING_COPY_REPORT_MAX_BYTES);

      expect((await reportStep(run.id, result, W1, workingCopy)).status).toBe(204);
      expectProblem(
        // One byte over the cap ('é' is two bytes, same length) is refused by the shared schema
        // (400), not by the body parser (413).
        await reportStep(run.id, { ...result, summary: `é${result.summary.slice(1)}` }),
        400,
      );
      // A failure report with the same Working copy report fits too (coordinator decision 1).
      expect(
        (
          await report(run.id, {
            state: 'failed',
            failure: { code: 'agent_failed', detail: 'd'.repeat(2000) },
            workingCopy,
          })
        ).status,
      ).toBe(204);
    });

    it('keeps the 100 KiB body limit on every other route (coordinator decision 2)', async () => {
      const big = 'x'.repeat(110 * 1024);
      const login = await http()
        .post('/api/auth/login')
        .set({ Origin: STUDIO_ORIGIN, 'Content-Type': 'application/json' })
        .send(JSON.stringify({ password: big }));
      expect(login.status).toBe(413);
      const claimed = await http()
        .post('/api/worker/runs/claim')
        .set({ Authorization: `Bearer ${WORKER_TOKEN}`, 'Content-Type': 'application/json' })
        .send(JSON.stringify({ workerId: W1, padding: big }));
      expect(claimed.status).toBe(413);
      const project = await readyProject('Shop');
      const started = await http()
        .post(`/api/projects/${project.id}/runs`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' })
        .send(JSON.stringify({ task: big, provider: 'codex' }));
      expect(started.status).toBe(413);
    });

    it("records a failed Run's Working copy state from the failure report (coordinator decision 1)", async () => {
      const project = await readyProject('Shop');
      const run = await queuedRun(project.id);
      await claim();
      await report(run.id, { state: 'running' });
      const workingCopy = {
        runBranch: WORKING_COPY.runBranch,
        commits: [{ id: 'e'.repeat(40), subject: 'Half done' }],
        hasUncommittedChanges: true,
      };

      const failed = await report(run.id, {
        state: 'failed',
        failure: { code: 'agent_failed', detail: 'The agent exited with code 1.' },
        workingCopy,
      });

      expect(failed.status).toBe(204);
      expect((await getRun(run.id)).body).toMatchObject({ state: 'failed', ...workingCopy });
      expectProblem(await report(run.id, { state: 'succeeded', workingCopy }), 400);
    });

    it('fails a Run during preparation', async () => {
      const project = await readyProject('Shop');
      const run = await queuedRun(project.id);
      await claim();

      await report(run.id, {
        state: 'failed',
        failure: { code: 'preparation_failed', detail: 'The working copy could not be made.' },
      });

      expect((await getRun(run.id)).body.state).toBe('failed');
    });

    it('releases a Run that waits for the operator, which still holds the project', async () => {
      const project = await readyProject('Shop');
      const run = await queuedRun(project.id);
      await queuedRun(project.id, 'second');
      await claim();
      await report(run.id, { state: 'running' });
      await reportStep(run.id, {
        outcome: 'needs_input',
        summary: 'Stuck.',
        question: 'Which DB?',
      });

      expect((await report(run.id, { state: 'waiting_for_operator' })).status).toBe(204);

      expect((await getRun(run.id)).body.state).toBe('waiting_for_operator');
      expectProblem(await heartbeat(run.id), 409, PROBLEM.runNotHeld);
      expect((await claim(W2)).status).toBe(204);
    });

    describe('concurrency', () => {
      it('hands out one active Run per project and two across the server, in start order', async () => {
        const [a, b, c] = [
          await readyProject('Alpha'),
          await readyProject('Beta'),
          await readyProject('Gamma'),
        ];
        const a1 = await queuedRun(a.id, 'a1');
        const a2 = await queuedRun(a.id, 'a2');
        const b1 = await queuedRun(b.id, 'b1');
        const c1 = await queuedRun(c.id, 'c1');

        expect((await claim(W1)).body.runId).toBe(a1.id);
        expect((await claim(W2)).body.runId).toBe(b1.id);
        expect((await claim(W2)).status).toBe(204);
        expect((await getRun(a2.id)).body.state).toBe('queued');
        expect((await getRun(c1.id)).body.state).toBe('queued');

        await report(a1.id, { state: 'running' }, W1);
        await report(a1.id, { state: 'succeeded', delivery: { outcome: 'none' } }, W1);
        expect((await claim(W1)).body.runId).toBe(a2.id);
        expect((await claim(W1)).status).toBe(204);
      });

      it('lets concurrent claims hand out at most two Runs, never two of one project', async () => {
        const projects = [
          await readyProject('One'),
          await readyProject('Two'),
          await readyProject('Three'),
        ];
        for (const project of projects) {
          await queuedRun(project.id, 'first');
          await queuedRun(project.id, 'second');
        }

        const responses = await Promise.all(Array.from({ length: 8 }, () => claim(randomUUID())));

        const claimed = responses.filter((response) => response.status === 200);
        expect(responses.every((response) => [200, 204].includes(response.status))).toBe(true);
        expect(claimed).toHaveLength(2);
        const claimedProjects = claimed.map((response) => response.body.projectId);
        expect(new Set(claimedProjects).size).toBe(2);
        const states = (await http().get('/api/runs').set('Cookie', cookie)).body.map(
          (run: { state: string }) => run.state,
        );
        expect(states.filter((state: string) => state === 'preparing')).toHaveLength(2);
        expect(states.filter((state: string) => state === 'queued')).toHaveLength(4);
      });
    });

    describe('lost worker', () => {
      it('fails a claimed Run without a heartbeat within the lease as worker_lost', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim(W1);
        await report(run.id, { state: 'running' }, W1);

        advance(LEASE_SECONDS + 1);
        expect((await claim(W2)).status).toBe(204);

        expect((await getRun(run.id)).body).toMatchObject({
          state: 'failed',
          failure: {
            code: 'worker_lost',
            detail: `The agent worker sent no heartbeat for ${LEASE_SECONDS} seconds.`,
          },
        });
        expectProblem(await heartbeat(run.id, W1), 409, PROBLEM.runNotHeld);
        expectProblem(
          await report(run.id, { state: 'succeeded', delivery: { outcome: 'none' } }, W1),
          409,
          PROBLEM.runNotHeld,
        );
      });

      it('keeps a Run whose worker sends heartbeats', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim(W1);

        advance(LEASE_SECONDS - 10);
        expect((await heartbeat(run.id, W1)).status).toBe(204);
        advance(LEASE_SECONDS - 10);
        await claim(W2);

        expect((await getRun(run.id)).body.state).toBe('preparing');
      });

      it('never fails a Run waiting for the operator', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim(W1);
        await report(run.id, { state: 'running' }, W1);
        await report(run.id, { state: 'waiting_for_operator' }, W1);

        advance(3600);
        await claim(W2);

        expect((await getRun(run.id)).body.state).toBe('waiting_for_operator');
      });
    });

    describe('rejected requests', () => {
      it('rejects a request without the worker token, or with a wrong one', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);

        expectProblem(await worker('claim', { workerId: W1 }, null), 401);
        expectProblem(
          await worker('claim', { workerId: W1 }, randomBytes(32).toString('base64')),
          401,
        );
        expectProblem(
          await http()
            .post('/api/worker/runs/claim')
            .set('Authorization', `Basic ${WORKER_TOKEN}`)
            .send({ workerId: W1 }),
          401,
        );
        expect((await getRun(run.id)).body.state).toBe('queued');
      });

      it('grants the operator session nothing on the worker routes', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);

        const response = await http()
          .post('/api/worker/runs/claim')
          .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
          .send({ workerId: W1 });

        expectProblem(response, 401);
        expect((await getRun(run.id)).body.state).toBe('queued');
      });

      it('grants the worker token nothing on the operator routes', async () => {
        const project = await readyProject('Shop');
        const bearer = { Authorization: `Bearer ${WORKER_TOKEN}` };

        expectProblem(await http().get('/api/runs').set(bearer), 401);
        expectProblem(await http().get('/api/projects').set(bearer), 401);
        expectProblem(
          await http()
            .post(`/api/projects/${project.id}/runs`)
            .set({ ...bearer, Origin: STUDIO_ORIGIN })
            .send({ task: 'x', provider: 'codex' }),
          401,
        );
      });

      it('rejects every worker request when no worker token is configured (fail closed)', async () => {
        const closed = await startStudioApp(
          { ...services.config, workerToken: null },
          WITHOUT_QUEUE_WORKERS,
        );
        try {
          const response = await request(closed.getHttpServer())
            .post('/api/worker/runs/claim')
            .set('Authorization', `Bearer ${WORKER_TOKEN}`)
            .send({ workerId: W1 });
          expectProblem(response, 401);
        } finally {
          await closed.close();
        }
      });

      it('rejects an illegal transition with 409 and changes nothing', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim(W1);

        const response = await report(
          run.id,
          { state: 'succeeded', delivery: { outcome: 'none' } },
          W1,
        );

        expectProblem(response, 409, PROBLEM.illegalRunTransition);
        expect(response.body.detail).toBe('A Run cannot go from preparing to succeeded.');
        expect((await getRun(run.id)).body.state).toBe('preparing');
      });

      it("rejects reports on another worker's Run with 409", async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim(W1);

        expectProblem(await report(run.id, { state: 'running' }, W2), 409, PROBLEM.runNotHeld);
        expectProblem(await heartbeat(run.id, W2), 409, PROBLEM.runNotHeld);
        expectProblem(
          await reportStep(run.id, { outcome: 'done', summary: '' }, W2),
          409,
          PROBLEM.runNotHeld,
        );
        expect((await getRun(run.id)).body.state).toBe('preparing');
      });

      it('rejects a step before the Run is running', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim(W1);

        expectProblem(
          await reportStep(run.id, { outcome: 'done', summary: '' }, W1),
          409,
          PROBLEM.runNotHeld,
        );
      });

      it('answers 404 for an unknown Run and 400 for a malformed body', async () => {
        expectProblem(await report(randomUUID(), { state: 'running' }), 404, PROBLEM.runNotFound);
        expectProblem(await heartbeat('nope'), 404, PROBLEM.runNotFound);
        expectProblem(await worker('claim', { workerId: 'worker-1' }), 400);
        expectProblem(await report(randomUUID(), { state: 'failed' }), 400);
        expectProblem(
          await reportStep(randomUUID(), { outcome: 'needs_input', summary: 'no question' }),
          400,
        );
      });
    });
  });
});
