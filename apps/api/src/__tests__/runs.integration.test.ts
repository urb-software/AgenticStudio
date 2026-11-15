import { jsonByteLength, RUN_STEP_RESULT_MAX_BYTES } from '@agentic-studio/contracts';
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
};

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
    return { id: project!.id, head };
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
  const reportStep = (runId: string, result: object, workerId = W1) =>
    worker(`${runId}/steps`, { workerId, kind: 'start', result });
  const heartbeat = (runId: string, workerId = W1) => worker(`${runId}/heartbeat`, { workerId });

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
      expect((await report(run.id, { state: 'succeeded' })).status).toBe(204);

      const finished = (await getRun(run.id)).body;
      expect(finished).toMatchObject({
        state: 'succeeded',
        finishedAt: clock.current.toISOString(),
      });
      expect(finished).not.toHaveProperty('failure');
      expect((await claim()).status).toBe(204);
      // The step is internal (not in the operator contract yet): checked in the table.
      const steps = await db().$queryRaw<{ index: number; kind: string; result: unknown }[]>`
        SELECT index, kind, result FROM run_steps WHERE run_id = ${run.id}::uuid`;
      expect(steps).toEqual([{ index: 1, kind: 'start', result }]);
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

      expect((await reportStep(run.id, result)).status).toBe(204);
      expectProblem(
        // One byte over the cap ('é' is two bytes, same length) is refused by the shared schema
        // (400), not by the body parser (413).
        await reportStep(run.id, { ...result, summary: `é${result.summary.slice(1)}` }),
        400,
      );
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
        await report(a1.id, { state: 'succeeded' }, W1);
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
        expectProblem(await report(run.id, { state: 'succeeded' }, W1), 409, PROBLEM.runNotHeld);
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

        const response = await report(run.id, { state: 'succeeded' }, W1);

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
