import {
  BASE_RULES,
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
import { WITHOUT_QUEUE_WORKERS, createTestDataDir } from './test-config.js';

// The Run API over HTTP on the real app (PostgreSQL and Redis via Testcontainers), outside
// src/modules/ because building the app reaches the database client; the worker's side is driven
// over its routes with a controlled clock for the lease.

// A throwaway worker token generated per run; no token is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const LEASE_SECONDS = 60;
const LIMITS = { stepMinutes: 60, maxSteps: 2, waitingDays: 14, maxTotalSteps: 3 };

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
  runAlreadyFinished: 'urn:agentic-studio:problem:run-already-finished',
  stepLimitReached: 'urn:agentic-studio:problem:step-limit-reached',
  stepOutOfOrder: 'urn:agentic-studio:problem:step-out-of-order',
  providerUnavailable: 'urn:agentic-studio:problem:provider-unavailable',
  deliveryNotRetryable: 'urn:agentic-studio:problem:delivery-not-retryable',
  runNotWaiting: 'urn:agentic-studio:problem:run-not-waiting',
  runNotResumable: 'urn:agentic-studio:problem:run-not-resumable',
  resumeSlotTaken: 'urn:agentic-studio:problem:resume-slot-taken',
  followUpNotAllowed: 'urn:agentic-studio:problem:follow-up-not-allowed',
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
  /** The next step number per Run, as the worker numbers its steps. */
  const nextStep = new Map<string, number>();
  const reportStep = async (
    runId: string,
    result: object,
    workerId = W1,
    workingCopy = WORKING_COPY,
    index = nextStep.get(runId) ?? 1,
  ) => {
    const response = await worker(`${runId}/steps`, {
      workerId,
      index,
      kind: 'start',
      result,
      workingCopy,
    });
    if (response.status === 204) nextStep.set(runId, index + 1);
    return response;
  };
  const runStates = (runIds: string[], token: string | null = WORKER_TOKEN) =>
    worker('states', { workerId: W1, runIds }, token);
  const heartbeat = (runId: string, workerId = W1) => worker(`${runId}/heartbeat`, { workerId });

  /** `POST /api/worker/status` as the agent worker sends it. */
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
      {
        ...services.config,
        workerToken: WORKER_TOKEN_DIGEST,
        workerLeaseSeconds: LEASE_SECONDS,
        runLimits: LIMITS,
      },
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
    // The last lease renewal at API start is per test as well.
    await db().$executeRaw`TRUNCATE TABLE run_lease_renewals`;
    clock.current = new Date();
    // A connected agent worker with both providers switched on.
    expect((await workerStatus()).status).toBe(204);
  });

  describe('operator endpoints', () => {
    it('starts a queued Run from the current integration branch commit and reads it back', async () => {
      const project = await readyProject('Shop');

      const created = await startRun(project.id, { task: 'Fix the login bug', provider: 'codex' });

      expect(created.status).toBe(201);
      expect(created.body).toEqual({ id: expect.stringMatching(UUID) });
      const read = (await getRun(created.body.id)).body;
      expect(read).toEqual({
        id: created.body.id,
        projectId: project.id,
        provider: 'codex',
        // The built-in Default agent of the Provider, recorded at start.
        agent: {
          name: 'default-codex',
          source: 'built_in',
          commit: null,
          provider: 'codex',
          model: 'default',
          instructions: '',
        },
        task: 'Fix the login bug',
        state: 'queued',
        startCommit: project.head,
        createdAt: expect.stringMatching(ISO_8601),
        // Set when the Run is claimed.
        environmentFileSupplied: false,
        // The limits in force, copied onto the Run when it is started.
        limits: LIMITS,
        // No Run step and no Follow-up yet.
        steps: { used: 0, usedInPart: 0 },
        followUps: 0,
        // The conversation starts with the Task.
        messages: [
          {
            role: 'operator',
            kind: 'task',
            text: 'Fix the login bug',
            at: read.createdAt,
          },
        ],
        // The Run page also learns whether a Follow-up is possible.
        followUp: { allowed: false, reason: 'not_finished' },
        // No Merge credential is set in this app, and the page learns why.
        merge: { available: false, reason: 'not_configured' },
        // The merge confirmation names the branch the pull request merges into.
        integrationBranch: 'dev',
      });
      const projectRuns = await http()
        .get(`/api/projects/${project.id}/runs`)
        .set('Cookie', cookie);
      expect(projectRuns.status).toBe(200);
      // Lists leave the conversation out.
      const {
        messages: _messages,
        followUp: _followUp,
        merge: _merge,
        integrationBranch: _integrationBranch,
        ...listed
      } = read;
      void _messages;
      void _followUp;
      void _merge;
      void _integrationBranch;
      expect(projectRuns.body).toEqual([listed]);
      expect((await http().get('/api/runs').set('Cookie', cookie)).body).toEqual([listed]);
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
      expect((await getRun(trimmed.body.id)).body.task).toBe('Fix it');
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

    it('summarizes the Runs under way and waiting for the operator', async () => {
      const summary = () => http().get('/api/runs/summary').set('Cookie', cookie);
      expect((await summary()).body).toEqual({ running: 0, waiting: 0 });
      const shop = await readyProject('Shop');
      const blog = await readyProject('Blog');
      const waiting = await queuedRun(shop.id);
      await queuedRun(shop.id, 'second');
      await queuedRun(blog.id, 'third');
      await claim();
      await report(waiting.id, { state: 'running' });
      await reportStep(waiting.id, {
        outcome: 'needs_input',
        summary: 'Stuck.',
        question: { text: 'Which DB?' },
        sessionRef: 'session-1',
      });
      await report(waiting.id, { state: 'waiting_for_operator' });

      const response = await summary();

      expect(response.status).toBe(200);
      // Shop's second Run is queued, Blog's is queued or preparing: both under way.
      expect(response.body).toEqual({ running: 2, waiting: 1 });
    });

    it('answers 404 for an unknown Run', async () => {
      expectProblem(await getRun(randomUUID()), 404, PROBLEM.runNotFound);
      expectProblem(await getRun('nope'), 404, PROBLEM.runNotFound);
    });

    it('requires the operator session', async () => {
      expectProblem(await http().get('/api/runs'), 401);
      expectProblem(await http().get('/api/runs/summary'), 401);
      expectProblem(
        await http()
          .post(`/api/projects/${randomUUID()}/runs`)
          .set('Origin', STUDIO_ORIGIN)
          .send({ task: 'x', provider: 'codex' }),
        401,
      );
    });
  });

  describe('provider availability', () => {
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

    it("shows the worker's reason for a switched-on provider it cannot run", async () => {
      const project = await readyProject('Shop');
      const reason = 'Claude Code 2.2.0 is not a supported version (supported: >=2.1.325 <2.2.0).';
      const call = await http()
        .post('/api/worker/status')
        .set('Authorization', `Bearer ${WORKER_TOKEN}`)
        .send({
          workerId: W1,
          runner: 'cli',
          providers: BOTH_ENABLED,
          providerReasons: { claude_code: reason },
        });
      expect(call.status).toBe(204);

      expect((await providers()).body).toEqual([
        { id: 'claude_code', name: 'Claude Code', available: false, reason },
        { id: 'codex', name: 'Codex', available: true },
      ]);
      const refused = await startRun(project.id, { task: 'x', provider: 'claude_code' });
      expectProblem(refused, 409, PROBLEM.providerUnavailable);
      expect(refused.body.detail).toBe(reason);
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
        { ...services.config, dataDir: createTestDataDir(), workerToken: WORKER_TOKEN_DIGEST },
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

    // The agent side's disk figures, shown on the Executions page.
    describe('agent worker disk', () => {
      const GIB = 1024 ** 3;
      const DISK = {
        workingCopiesBytes: 3 * GIB,
        cachesBytes: GIB,
        keptRuns: 4,
        freeBytes: 40 * GIB,
        totalBytes: 100 * GIB,
        minFreeBytes: 10 * GIB,
      };
      const agentWorker = () => http().get('/api/agent-worker').set('Cookie', cookie);
      const reportDisk = (disk: object) =>
        http()
          .post('/api/worker/status')
          .set('Authorization', `Bearer ${WORKER_TOKEN}`)
          .send({ workerId: W1, runner: 'cli', providers: BOTH_ENABLED, disk });

      it('shows the figures of the latest report, and whether free space is below the threshold', async () => {
        expect((await reportDisk(DISK)).status).toBe(204);
        expect((await agentWorker()).body).toEqual({
          connected: true,
          disk: { ...DISK, low: false },
        });

        expect((await reportDisk({ ...DISK, freeBytes: 9 * GIB })).status).toBe(204);
        expect((await agentWorker()).body).toMatchObject({ connected: true, disk: { low: true } });
      });

      it('shows no figures before the worker measured, and none once its report is stale', async () => {
        expect((await workerStatus()).status).toBe(204);
        expect((await agentWorker()).body).toEqual({ connected: true });

        expect((await reportDisk(DISK)).status).toBe(204);
        advance(LEASE_SECONDS + 1);
        expect((await agentWorker()).body).toEqual({ connected: false });
      });

      it('refuses a malformed report, and the page needs the operator session', async () => {
        expectProblem(await reportDisk({ ...DISK, keptRuns: -1 }), 400);
        expectProblem(await http().get('/api/agent-worker'), 401);
        expectProblem(
          await http().get('/api/agent-worker').set('Authorization', `Bearer ${WORKER_TOKEN}`),
          401,
        );
      });
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
        // Studio's base rules and the Run's recorded agent: the worker has no copy of its own.
        baseRules: { version: BASE_RULES.version, text: BASE_RULES.text },
        agent: {
          name: 'default-claude-code',
          source: 'built_in',
          commit: null,
          provider: 'claude_code',
          model: 'default',
          instructions: '',
        },
        task: 'Add a health check',
        startCommit: project.head,
        // The remote as connected; nothing else about the Repository.
        repository: { remoteUrl: project.url },
        // The pull request's base, a Run to start (not only deliver), no Studio-placed files yet.
        integrationBranch: 'dev',
        kind: 'start',
        studioPaths: [],
        // The limits the worker enforces, and no Run step taken yet.
        limits: { stepMinutes: LIMITS.stepMinutes, maxSteps: LIMITS.maxSteps },
        completedSteps: 0,
        // The first part of the Run starts its allowance at 0.
        stepsBeforePart: 0,
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
      const beat = await heartbeat(run.id);
      expect(beat.status).toBe(200);
      expect(beat.body).toEqual({ cancelRequested: false });
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
      // The Working copy state of the latest step, on the operator's Run.
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

    it('shows no Working copy state before the first step, then the latest one', async () => {
      const project = await readyProject('Shop');
      const run = await queuedRun(project.id);
      await claim();
      await report(run.id, { state: 'running' });
      const before = (await getRun(run.id)).body;
      expect(before).not.toHaveProperty('runBranch');
      expect(before).not.toHaveProperty('commits');
      expect(before).not.toHaveProperty('hasUncommittedChanges');

      await reportStep(run.id, {
        outcome: 'needs_input',
        summary: 'Stuck.',
        question: { text: 'Q?' },
        sessionRef: 'session-1',
      });
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

    it('rejects a step report without a valid Working copy state with 400', async () => {
      const project = await readyProject('Shop');
      const run = await queuedRun(project.id);
      await claim();
      await report(run.id, { state: 'running' });
      const result = { outcome: 'done', summary: 'Done.' };

      expectProblem(
        await worker(`${run.id}/steps`, { workerId: W1, index: 1, kind: 'start', result }),
        400,
      );
      expectProblem(
        await reportStep(run.id, result, W1, {
          ...WORKING_COPY,
          commits: [{ id: 'not-a-commit', subject: 'x' }],
        }),
        400,
      );
      expect((await getRun(run.id)).body).not.toHaveProperty('runBranch');
    });

    it('answers the states of known Runs for the retention, leaving out unknown ids', async () => {
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
          {
            runId: finished.id,
            state: 'failed',
            finishedAt: clock.current.toISOString(),
            // A Run without a pull request is kept seven days from its result.
            keepUntil: new Date(clock.current.getTime() + 7 * 24 * 60 * 60_000).toISOString(),
          },
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

    it('removes beyond the newest ten finished Runs with a Working copy and no pull request, and no other', async () => {
      const project = await readyProject('Shop');
      const other = await readyProject('Other');
      const withCopy: string[] = [];
      const fresh = async () => expect((await workerStatus()).status).toBe(204);
      const finishWithCopy = async (projectId: string, delivery: object) => {
        const run = await queuedRun(projectId, `Task ${withCopy.length}`);
        await claim();
        await report(run.id, { state: 'running' });
        expect((await reportStep(run.id, { outcome: 'done', summary: 'Done.' })).status).toBe(204);
        await report(run.id, { state: 'succeeded', delivery });
        advance(60);
        await fresh();
        return run.id;
      };
      // One Run at a time (one active Run per project), each finishing a minute after the last:
      // the project's oldest 11 have a Working copy and no pull request.
      for (let n = 0; n < 11; n++)
        withCopy.push(await finishWithCopy(project.id, { outcome: 'none' }));
      // A Run with a pull request, newer than all of them, is neither counted nor removed.
      const delivered = await finishWithCopy(project.id, {
        outcome: 'delivered',
        pullRequest: { url: 'https://github.com/acme/shop/pull/9', number: 9 },
      });
      const otherProject = await finishWithCopy(other.id, { outcome: 'none' });
      // Newest of all: failed before any Working copy (refused by the free-space guard, say).
      const never: string[] = [];
      for (let n = 0; n < 3; n++) {
        const run = await queuedRun(project.id, `Never ${n}`);
        await claim();
        await report(run.id, {
          state: 'failed',
          failure: { code: 'preparation_failed', detail: 'x' },
        });
        never.push(run.id);
        advance(60);
        await fresh();
      }

      const response = await runStates([...withCopy, delivered, otherProject, ...never]);

      expect(response.status).toBe(200);
      const removable = (response.body as { runId: string; removable?: true }[])
        .filter((entry) => entry.removable)
        .map((entry) => entry.runId);
      // Only the oldest of the 11: the Run with a pull request, the other project's Run and the
      // Runs that never had a Working copy fill no place.
      expect(removable).toEqual([withCopy[0]]);
    });

    describe('delivery', () => {
      const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
      const DONE = { outcome: 'done', summary: 'Added GET /health.' };

      /** A Run carried to the end of its step by W1. */
      async function steppedRun(result: object = DONE) {
        const project = await readyProject(`Shop ${randomUUID()}`);
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
        expect(requested.body).toEqual({});
        expect((await getRun(run.id)).body).toMatchObject({
          id: run.id,
          state: 'failed',
          deliveryRetryRequested: true,
        });
        expect((await retryDelivery(run.id)).status).toBe(202);

        const claimed = await claim(W1);
        expect(claimed.status).toBe(200);
        // Only the worker that started the Run gets it (it has the Working copy), with the Run
        // branch Studio recorded.
        expect(claimed.body).toMatchObject({
          runId: run.id,
          kind: 'deliver',
          runBranch: WORKING_COPY.runBranch,
          studioPaths: [],
        });
        expect((await claim(W2)).status).toBe(204);
        expect((await heartbeat(run.id, W1)).body).toEqual({ cancelRequested: false });
        advance(5);

        const reported = await report(
          run.id,
          {
            state: 'succeeded',
            delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
            workingCopy: WORKING_COPY,
          },
          W1,
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
        await claim(W1);

        await report(
          run.id,
          { state: 'failed', failure: { code: 'delivery_failed', detail: 'GitHub answered 503.' } },
          W1,
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
        await claim(W1);
        advance(LEASE_SECONDS + 1);

        expect((await claim(W2)).status).toBe(204);

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
        expect((await claim(W1)).body).toMatchObject({ runId: run.id, kind: 'deliver' });
        const sameProject = await queuedRun(projectId!);
        const other = await queuedRun((await readyProject('Other')).id);
        const third = await queuedRun((await readyProject('Third')).id);

        expect((await claim(W2)).body).toMatchObject({ runId: other.id });
        expect((await claim(W2)).status).toBe(204);
        expect((await getRun(sameProject.id)).body.state).toBe('queued');
        expect((await getRun(third.id)).body.state).toBe('queued');
      });

      it('refuses a retry for a Run whose delivery did not fail (409) and an unknown Run (404)', async () => {
        // Each Run is claimed before the next is queued, so every claim hands out that Run.
        const succeeded = await steppedRun();
        await report(succeeded.id, { state: 'succeeded', delivery: { outcome: 'none' } });
        const agentFailed = await queuedRun((await readyProject('Other')).id);
        await claim();
        await report(agentFailed.id, { state: 'running' });
        await report(agentFailed.id, {
          state: 'failed',
          failure: { code: 'agent_failed', detail: 'exit 1' },
        });
        const queued = await queuedRun((await readyProject('Shop')).id);

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

    it('accepts a step result of the maximum size within the JSON body limit', async () => {
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
      // With a Working copy report near its own cap, the body is over Express's default 100 KiB
      // and still accepted.
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
        question: { text: 'Which DB?' },
        sessionRef: 'session-1',
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
        expect((await heartbeat(run.id, W1)).status).toBe(200);
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

    // Cancel in each state, the step limit, long waits, and a Studio restart.
    describe('cancel and limits', () => {
      const cancel = (runId: string, origin: string | null = STUDIO_ORIGIN) => {
        const call = http().post(`/api/runs/${runId}/cancel`).set('Cookie', cookie);
        if (origin !== null) call.set('Origin', origin);
        return call.send();
      };

      it('cancels a queued Run at once', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        advance(3);

        const cancelled = await cancel(run.id);

        expect(cancelled.status).toBe(202);
        expect(cancelled.body).toEqual({ outcome: 'cancelled' });
        // The Run page reads the Run, which also says whether a Follow-up is possible.
        expect((await getRun(run.id)).body).toMatchObject({
          id: run.id,
          state: 'cancelled',
          finishedAt: clock.current.toISOString(),
          cancellation: { by: 'operator', reason: 'Cancelled by the operator.' },
          followUp: { allowed: false, reason: 'no_session' },
        });
        expect((await claim()).status).toBe(204);
      });

      it('cancels a Run waiting for the operator at once, freeing its project', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await report(run.id, { state: 'running' });
        await report(run.id, { state: 'waiting_for_operator' });

        expect((await cancel(run.id)).body).toEqual({ outcome: 'cancelled' });
        const next = await queuedRun(project.id, 'Next task');
        expect((await claim()).body.runId).toBe(next.id);
      });

      it('delivers a cancel of a running Run with the next heartbeat; the worker confirms it', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await report(run.id, { state: 'running' });
        const requestedAt = clock.current.toISOString();

        const requested = await cancel(run.id);
        expect(requested.status).toBe(202);
        expect(requested.body).toEqual({ outcome: 'cancel_requested' });
        expect((await getRun(run.id)).body).toMatchObject({
          state: 'running',
          cancelRequestedAt: requestedAt,
        });
        expect((await getRun(run.id)).body).not.toHaveProperty('cancellation');

        advance(5);
        const repeated = await cancel(run.id);
        expect(repeated.status).toBe(202);
        expect(repeated.body).toEqual({ outcome: 'cancel_requested' });
        expect((await getRun(run.id)).body.cancelRequestedAt).toBe(requestedAt);

        const beat = await heartbeat(run.id);
        expect(beat.status).toBe(200);
        expect(beat.body).toEqual({ cancelRequested: true });

        expect(
          (await report(run.id, { state: 'cancelled', workingCopy: WORKING_COPY })).status,
        ).toBe(204);
        expect((await getRun(run.id)).body).toMatchObject({
          state: 'cancelled',
          cancellation: { by: 'operator' },
          runBranch: WORKING_COPY.runBranch,
          finishedAt: clock.current.toISOString(),
        });
      });

      it('ends a Run as cancelled when its step ends normally after a cancel request', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await cancel(run.id);
        await report(run.id, { state: 'running' });

        await report(run.id, { state: 'waiting_for_operator' });

        expect((await getRun(run.id)).body).toMatchObject({
          state: 'cancelled',
          cancellation: { by: 'operator' },
        });
      });

      it('reports a cancel of a finished Run clearly, and an unknown Run as not found', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await cancel(run.id);

        const again = await cancel(run.id);
        expectProblem(again, 409, PROBLEM.runAlreadyFinished);
        expect(again.body.title).toBe('Run already finished');
        expectProblem(await cancel(randomUUID()), 404, PROBLEM.runNotFound);
        expectProblem(await cancel('nope'), 404, PROBLEM.runNotFound);
      });

      it('refuses a cancel without a session or from another origin', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);

        const withoutSession = await http()
          .post(`/api/runs/${run.id}/cancel`)
          .set('Origin', STUDIO_ORIGIN)
          .send();
        expect(withoutSession.status).toBe(401);
        expect((await cancel(run.id, 'https://evil.example.test')).status).toBe(403);
        expect((await getRun(run.id)).body.state).toBe('queued');
      });

      it('refuses a cancelled report nobody asked for', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await report(run.id, { state: 'running' });

        expectProblem(
          await report(run.id, { state: 'cancelled' }),
          409,
          PROBLEM.illegalRunTransition,
        );
      });

      it('ends a Run step stopped at its time limit as timed_out', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await report(run.id, { state: 'running' });

        expect(
          (await report(run.id, { state: 'timed_out', workingCopy: WORKING_COPY })).status,
        ).toBe(204);
        const timedOut = (await getRun(run.id)).body;
        expect(timedOut).toMatchObject({ state: 'timed_out', limits: LIMITS });
        expect(timedOut).not.toHaveProperty('failure');
      });

      it('refuses a Run step beyond the maximum and fails the Run with step_limit', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await report(run.id, { state: 'running' });
        const result = { outcome: 'done', summary: 'Done.' };
        expect((await reportStep(run.id, result)).status).toBe(204);
        expect((await reportStep(run.id, result)).status).toBe(204);

        expectProblem(await reportStep(run.id, result), 409, PROBLEM.stepLimitReached);

        expect((await getRun(run.id)).body).toMatchObject({
          state: 'failed',
          failure: {
            code: 'step_limit',
            detail: 'The run reached its limit of 2 run steps; no further step was started.',
          },
        });
        const rows = await db().$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count FROM run_steps WHERE run_id = ${run.id}::uuid`;
        expect(rows[0]?.count).toBe(2);
      });

      it('cancels a Run waiting longer than its waiting period, by the system', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await report(run.id, { state: 'running' });
        await report(run.id, { state: 'waiting_for_operator' });

        // The sweep also runs before every claim: a waiting Run holds a slot.
        advance(LIMITS.waitingDays * 24 * 3600);
        expect((await claim(W2)).status).toBe(204);
        expect((await getRun(run.id)).body.state).toBe('waiting_for_operator');

        advance(1);
        expect((await claim(W2)).status).toBe(204);
        expect((await getRun(run.id)).body).toMatchObject({
          state: 'cancelled',
          cancellation: {
            by: 'system',
            reason: 'Cancelled automatically: the run waited for the operator longer than 14 days.',
          },
        });
      });

      it('renews the leases of held Runs when Studio starts, so a short outage fails none', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await report(run.id, { state: 'running' });

        // Studio was down longer than the lease; an instance starts again on the same database.
        advance(LEASE_SECONDS * 3);
        const restarted = await startStudioApp(
          {
            ...services.config,
            dataDir: createTestDataDir(),
            workerToken: WORKER_TOKEN_DIGEST,
            workerLeaseSeconds: LEASE_SECONDS,
            runLimits: LIMITS,
          },
          { executions: { clock } },
        );
        try {
          advance(LEASE_SECONDS - 5);
          expect((await claim(W2)).status).toBe(204);
          expect((await getRun(run.id)).body.state).toBe('running');
          // The worker, back in touch, delivers its buffered reports.
          expect((await heartbeat(run.id)).body).toEqual({ cancelRequested: false });
          expect((await reportStep(run.id, { outcome: 'done', summary: 'Done.' })).status).toBe(
            204,
          );
          expect(
            (await report(run.id, { state: 'succeeded', delivery: { outcome: 'none' } })).status,
          ).toBe(204);
        } finally {
          await restarted.close();
        }
        // A worker that is really gone is still noticed one lease later.
        expect((await workerStatus()).status).toBe(204);
        const other = await queuedRun(project.id, 'Another');
        await claim();
        advance(LEASE_SECONDS + 1);
        await claim(W2);
        expect((await getRun(other.id)).body.failure?.code).toBe('worker_lost');
      });
    });

    // A report Studio applied but whose answer the worker never got is sent again; the repeat
    // changes nothing and succeeds, so the Run goes on.
    describe('retried reports', () => {
      it('accepts repeated running, step and end reports without changing or duplicating anything', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        expect((await report(run.id, { state: 'running' })).status).toBe(204);
        expect((await report(run.id, { state: 'running' })).status).toBe(204);
        const result = { outcome: 'done', summary: 'Done.' };
        expect((await reportStep(run.id, result, W1, WORKING_COPY, 1)).status).toBe(204);
        expect((await reportStep(run.id, result, W1, WORKING_COPY, 1)).status).toBe(204);
        expect(
          (await report(run.id, { state: 'succeeded', delivery: { outcome: 'none' } })).status,
        ).toBe(204);
        advance(5);
        expect(
          (await report(run.id, { state: 'succeeded', delivery: { outcome: 'none' } })).status,
        ).toBe(204);

        const finished = (await getRun(run.id)).body;
        expect(finished.state).toBe('succeeded');
        // The repeat did not move the finish time.
        expect(finished.finishedAt).not.toBe(clock.current.toISOString());
        const rows = await db().$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count FROM run_steps WHERE run_id = ${run.id}::uuid`;
        expect(rows[0]?.count).toBe(1);
        // Another worker, or a different end, is still refused.
        expectProblem(
          await report(run.id, { state: 'succeeded', delivery: { outcome: 'none' } }, W2),
          409,
          PROBLEM.runNotHeld,
        );
      });

      it('refuses a step number that skips ahead', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await report(run.id, { state: 'running' });

        expectProblem(
          await reportStep(run.id, { outcome: 'done', summary: 'x' }, W1, WORKING_COPY, 2),
          409,
          PROBLEM.stepOutOfOrder,
        );
      });

      it("times out a Run whose step runs past its limit plus Studio's grace, despite heartbeats", async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await report(run.id, { state: 'running' });

        for (let minute = 0; minute < LIMITS.stepMinutes + 5; minute += 1) {
          advance(60);
          expect((await heartbeat(run.id)).status).toBe(200);
        }
        expect((await claim(W2)).status).toBe(204);
        expect((await getRun(run.id)).body.state).toBe('running');

        advance(1);
        await heartbeat(run.id);
        expect((await claim(W2)).status).toBe(204);
        expect((await getRun(run.id)).body.state).toBe('timed_out');
        expectProblem(await heartbeat(run.id), 409, PROBLEM.runNotHeld);
      });

      it('records the pull request on a Run cancelled during its delivery', async () => {
        const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/9', number: 9 };
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await report(run.id, { state: 'running' });
        await http()
          .post(`/api/runs/${run.id}/cancel`)
          .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
          .send();

        expect(
          (
            await report(run.id, {
              state: 'cancelled',
              delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
            })
          ).status,
        ).toBe(204);
        expect((await getRun(run.id)).body).toMatchObject({
          state: 'cancelled',
          cancellation: { by: 'operator' },
          delivery: 'delivered',
          pullRequest: PULL_REQUEST,
        });
      });

      it("stops Studio's step clock when the step result is reported (a slow delivery is not timed out)", async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await report(run.id, { state: 'running' });
        expect((await reportStep(run.id, { outcome: 'done', summary: 'Done.' })).status).toBe(204);

        for (let minute = 0; minute < LIMITS.stepMinutes + 10; minute += 1) {
          advance(60);
          expect((await heartbeat(run.id)).status).toBe(200);
        }
        await claim(W2);

        expect((await getRun(run.id)).body.state).toBe('running');
      });

      it('renews leases at most once per lease period, so an API crash loop fails a dead worker', async () => {
        const project = await readyProject('Shop');
        const run = await queuedRun(project.id);
        await claim();
        await report(run.id, { state: 'running' });
        const config = {
          ...services.config,
          dataDir: createTestDataDir(),
          workerToken: WORKER_TOKEN_DIGEST,
          workerLeaseSeconds: LEASE_SECONDS,
          runLimits: LIMITS,
        };
        // Studio restarts once after a long outage, renewing the lease ...
        advance(LEASE_SECONDS * 10);
        await (await startStudioApp(config, { executions: { clock } })).close();
        // ... then keeps crashing and restarting; the worker is gone.
        for (const seconds of [20, 20, 15]) {
          advance(seconds);
          await (await startStudioApp(config, { executions: { clock } })).close();
        }
        advance(10);
        expect((await workerStatus()).status).toBe(204);
        await claim(W2);

        expect((await getRun(run.id)).body.failure?.code).toBe('worker_lost');
      });
    });

    // A question pauses the Run, the operator's answer resumes the same session on the worker that
    // holds the Working copy.
    describe('questions and answers', () => {
      const QUESTION = {
        text: 'Which database should the store use?',
        options: ['PostgreSQL', 'SQLite'],
        recommendation: 'PostgreSQL',
      };
      const answer = (runId: string, body: unknown, origin: string | null = STUDIO_ORIGIN) => {
        const call = http().post(`/api/runs/${runId}/answer`).set('Cookie', cookie);
        if (origin !== null) call.set('Origin', origin);
        return call.send(body as object);
      };
      const step = (
        runId: string,
        index: number,
        kind: 'start' | 'resume',
        result: object,
        workerId = W1,
      ) => worker(`${runId}/steps`, { workerId, index, kind, result, workingCopy: WORKING_COPY });
      const asking = (text = QUESTION.text) => ({
        outcome: 'needs_input',
        summary: 'A decision is needed.',
        question: { ...QUESTION, text },
        sessionRef: 'session-1',
      });
      /** Events of step `stepIndex` with these seqs, as the worker sends them. */
      const events = (runId: string, stepIndex: number, seqs: number[], workerId = W1) =>
        worker(`${runId}/events`, {
          workerId,
          events: seqs.map((seq) => ({
            seq,
            at: clock.current.toISOString(),
            stepIndex,
            kind: 'message',
            text: `event ${seq}`,
          })),
        });

      /** W1 claims the queued Run and carries its first step to a question. */
      async function askedRun(projectId: string, task = 'Add a store') {
        const run = await queuedRun(projectId, task);
        expect((await claim()).body.kind).toBe('start');
        await report(run.id, { state: 'running' });
        expect((await events(run.id, 1, [1, 2, 3])).status).toBe(204);
        expect((await step(run.id, 1, 'start', asking())).status).toBe(204);
        expect((await report(run.id, { state: 'waiting_for_operator' })).status).toBe(204);
        return run;
      }

      it('shows the question, takes the answer and resumes the same session to success', async () => {
        const project = await readyProject('Shop');
        const run = await askedRun(project.id);

        const waiting = (await getRun(run.id)).body;
        expect(waiting).toMatchObject({ state: 'waiting_for_operator', question: QUESTION });
        expect(waiting.messages).toEqual([
          { role: 'operator', kind: 'task', text: 'Add a store', at: waiting.createdAt },
          {
            role: 'agent',
            kind: 'question',
            text: QUESTION.text,
            options: QUESTION.options,
            recommendation: QUESTION.recommendation,
            at: expect.stringMatching(ISO_8601),
          },
        ]);
        // Internal: the session reference never reaches the operator API.
        expect(JSON.stringify(waiting)).not.toContain('session-1');
        // Lists leave the conversation out; the state shows it waits.
        const [listed] = (await http().get('/api/runs').set('Cookie', cookie)).body;
        expect(listed).toMatchObject({ id: run.id, state: 'waiting_for_operator' });
        expect(listed).not.toHaveProperty('messages');
        expect(listed).not.toHaveProperty('question');

        advance(60);
        const answered = await answer(run.id, { text: '  PostgreSQL  ' });
        expect(answered.status).toBe(202);
        expect(answered.body).toEqual({});
        const afterAnswer = (await getRun(run.id)).body;
        expect(afterAnswer.state).toBe('queued');
        expect(afterAnswer).not.toHaveProperty('question');
        expect(afterAnswer.messages.at(-1)).toEqual({
          role: 'operator',
          kind: 'answer',
          text: 'PostgreSQL',
          at: clock.current.toISOString(),
        });

        // Only the worker that holds the Working copy and the session resumes it.
        expect((await claim(W2)).status).toBe(204);
        const resumed = await claim(W1);
        expect(resumed.status).toBe(200);
        expect(resumed.body).toMatchObject({
          runId: run.id,
          kind: 'resume',
          runBranch: WORKING_COPY.runBranch,
          sessionRef: 'session-1',
          answer: 'PostgreSQL',
          // The resumed step's events continue after the stored log.
          nextSeq: 4,
          completedSteps: 1,
        });
        expect((await getRun(run.id)).body).toMatchObject({
          state: 'preparing',
          startedAt: waiting.startedAt,
        });

        await report(run.id, { state: 'running' });
        expect((await events(run.id, 2, [4, 5])).status).toBe(204);
        expect(
          (await step(run.id, 2, 'resume', { outcome: 'done', summary: 'Done.' })).status,
        ).toBe(204);
        expect(
          (await report(run.id, { state: 'succeeded', delivery: { outcome: 'none' } })).status,
        ).toBe(204);

        expect((await getRun(run.id)).body.state).toBe('succeeded');
        const log = await http().get(`/api/runs/${run.id}/events`).set('Cookie', cookie);
        expect(log.body.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2, 3, 4, 5]);
      });

      it('asks more than once; each question ends a Run step toward the maximum', async () => {
        const project = await readyProject('Shop');
        const run = await askedRun(project.id);
        await answer(run.id, { text: 'PostgreSQL' });
        expect((await claim()).body).toMatchObject({ kind: 'resume', completedSteps: 1 });
        await report(run.id, { state: 'running' });
        expect((await step(run.id, 2, 'resume', asking('And the schema name?'))).status).toBe(204);
        await report(run.id, { state: 'waiting_for_operator' });

        expect((await getRun(run.id)).body.question.text).toBe('And the schema name?');
        await answer(run.id, { text: 'store' });

        // LIMITS.maxSteps is 2: the worker refuses a third step and reports step_limit.
        const third = await claim();
        expect(third.body).toMatchObject({ kind: 'resume', completedSteps: 2, answer: 'store' });
        await report(run.id, {
          state: 'failed',
          failure: {
            code: 'step_limit',
            detail: 'The run reached its limit of 2 run steps; no further step was started.',
          },
        });
        const failed = (await getRun(run.id)).body;
        expect(failed).toMatchObject({ state: 'failed', failure: { code: 'step_limit' } });
        expect(
          failed.messages.map((m: { kind: string; text: string }) => [m.kind, m.text]),
        ).toEqual([
          ['task', 'Add a store'],
          ['question', QUESTION.text],
          ['answer', 'PostgreSQL'],
          ['question', 'And the schema name?'],
          ['answer', 'store'],
        ]);
      });

      it('takes an answer only while the Run waits: a second one is refused clearly', async () => {
        const project = await readyProject('Shop');
        const queued = await queuedRun(project.id, 'Queued');
        expectProblem(await answer(queued.id, { text: 'x' }), 409, PROBLEM.runNotWaiting);
        await claim();
        await report(queued.id, { state: 'running' });
        expectProblem(await answer(queued.id, { text: 'x' }), 409, PROBLEM.runNotWaiting);
        await report(queued.id, { state: 'succeeded', delivery: { outcome: 'none' } });

        const run = await askedRun(project.id);
        expect((await answer(run.id, { text: 'PostgreSQL' })).status).toBe(202);
        const second = await answer(run.id, { text: 'SQLite' });
        expectProblem(second, 409, PROBLEM.runNotWaiting);
        expect(second.body.detail).toBe('The question was already answered; the run continues.');
        expect((await getRun(run.id)).body.messages.at(-1).text).toBe('PostgreSQL');
      });

      it('validates the answer (422), finds the Run (404) and guards the session and origin', async () => {
        const project = await readyProject('Shop');
        const run = await askedRun(project.id);

        expectProblem(await answer(run.id, { text: '   ' }), 422);
        expectProblem(await answer(run.id, { text: 'a'.repeat(10_001) }), 422);
        expectProblem(await answer(run.id, { text: 'ok', extra: true }), 422);
        expectProblem(await answer(run.id, {}), 422);
        expectProblem(await answer(randomUUID(), { text: 'x' }), 404, PROBLEM.runNotFound);
        expectProblem(await answer('nope', { text: 'x' }), 404, PROBLEM.runNotFound);
        expect((await answer(run.id, { text: 'x' }, 'https://evil.example.test')).status).toBe(403);
        const withoutSession = await http()
          .post(`/api/runs/${run.id}/answer`)
          .set('Origin', STUDIO_ORIGIN)
          .send({ text: 'x' });
        expect(withoutSession.status).toBe(401);
        expect((await getRun(run.id)).body.state).toBe('waiting_for_operator');
        expect((await answer(run.id, { text: 'a'.repeat(10_000) })).status).toBe(202);
      });

      it('refuses an answer after a cancel; an answered Run is cancelled at once, freeing its project', async () => {
        const project = await readyProject('Shop');
        const cancel = (runId: string) =>
          http().post(`/api/runs/${runId}/cancel`).set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
        const first = await askedRun(project.id, 'First');
        await cancel(first.id);
        const late = await answer(first.id, { text: 'x' });
        expectProblem(late, 409, PROBLEM.runNotWaiting);
        expect(late.body.detail).toBe('The run was cancelled; it takes no answer.');

        const second = await askedRun(project.id, 'Second');
        await answer(second.id, { text: 'PostgreSQL' });
        const next = await queuedRun(project.id, 'Third');
        // The answered Run keeps its project's place: another worker gets nothing.
        expect((await claim(W2)).status).toBe(204);
        expect((await cancel(second.id)).body).toEqual({ outcome: 'cancelled' });
        expect((await claim(W2)).body.runId).toBe(next.id);
      });

      it('loses nothing over a Studio restart while waiting', async () => {
        const project = await readyProject('Shop');
        const run = await askedRun(project.id);
        advance(24 * 3600);
        const restarted = await startStudioApp(
          {
            ...services.config,
            dataDir: createTestDataDir(),
            workerToken: WORKER_TOKEN_DIGEST,
            workerLeaseSeconds: LEASE_SECONDS,
            runLimits: LIMITS,
          },
          { executions: { clock } },
        );
        try {
          const after = await request(restarted.getHttpServer())
            .get(`/api/runs/${run.id}`)
            .set('Cookie', cookie);
          expect(after.body).toMatchObject({ state: 'waiting_for_operator', question: QUESTION });
        } finally {
          await restarted.close();
        }
        expect((await workerStatus()).status).toBe(204);
        await answer(run.id, { text: 'PostgreSQL' });
        expect((await claim()).body).toMatchObject({ kind: 'resume', sessionRef: 'session-1' });
      });

      it('fails a resume whose worker is gone as preparation_failed, so it can run again', async () => {
        const project = await readyProject('Shop');
        const run = await askedRun(project.id);
        await answer(run.id, { text: 'PostgreSQL' });

        // The interval sweep notices it: an instance with a 2-second lease sweeps every second.
        const shortLease = await startStudioApp(
          {
            ...services.config,
            dataDir: createTestDataDir(),
            workerToken: WORKER_TOKEN_DIGEST,
            workerLeaseSeconds: 2,
            runLimits: LIMITS,
          },
          { executions: { clock } },
        );
        try {
          advance(3);
          const deadline = Date.now() + 10_000;
          while ((await getRun(run.id)).body.state === 'queued' && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        } finally {
          await shortLease.close();
        }

        expect((await getRun(run.id)).body).toMatchObject({
          state: 'failed',
          failure: {
            code: 'preparation_failed',
            detail: expect.stringMatching(
              /^Working copy no longer exists \(agent worker gone\) — run again/,
            ),
          },
        });
      });

      it('records a resume the worker could not carry out: missing Working copy or refused session', async () => {
        const project = await readyProject('Shop');
        const missing = await askedRun(project.id, 'Missing');
        await answer(missing.id, { text: 'x' });
        await claim();
        await report(missing.id, {
          state: 'failed',
          failure: {
            code: 'preparation_failed',
            detail: 'Working copy no longer exists — run again.',
          },
        });
        expect((await getRun(missing.id)).body.failure.code).toBe('preparation_failed');

        const refused = await askedRun(project.id, 'Refused');
        await answer(refused.id, { text: 'x' });
        await claim();
        await report(refused.id, { state: 'running' });
        await report(refused.id, {
          state: 'failed',
          failure: { code: 'agent_failed', detail: 'The provider has no session session-1.' },
        });
        expect((await getRun(refused.id)).body.failure.code).toBe('agent_failed');
      });
    });

    describe('resume after the usage limit', () => {
      const USAGE_LIMIT = {
        code: 'usage_limit',
        detail: 'The Claude Code usage limit was reached; it resets at 2026-11-16T17:00:00.000Z.',
      };
      const resume = (runId: string, origin: string | null = STUDIO_ORIGIN) => {
        const call = http().post(`/api/runs/${runId}/resume`).set('Cookie', cookie);
        if (origin !== null) call.set('Origin', origin);
        return call.send();
      };

      /** W1 claims the queued Run; its first step stops at the usage limit. */
      async function limitedRun(projectId: string, sessionRef: string | null = 'session-9') {
        const run = await queuedRun(projectId);
        expect((await claim()).body.kind).toBe('start');
        await report(run.id, { state: 'running' });
        const failed = await report(run.id, {
          state: 'failed',
          failure: USAGE_LIMIT,
          workingCopy: WORKING_COPY,
          ...(sessionRef ? { sessionRef } : {}),
        });
        expect(failed.status).toBe(204);
        return run;
      }

      it('resumes the stopped session with "Continue where you stopped." on the same worker', async () => {
        const project = await readyProject('Shop');
        const run = await limitedRun(project.id);

        const stopped = (await getRun(run.id)).body;
        expect(stopped).toMatchObject({ state: 'failed', failure: USAGE_LIMIT, resumable: true });
        // Internal: the session reference never reaches the operator API.
        expect(JSON.stringify(stopped)).not.toContain('session-9');

        const resumed = await resume(run.id);
        expect(resumed.status).toBe(202);
        expect(resumed.body).toEqual({});
        const afterResume = (await getRun(run.id)).body;
        expect(afterResume).toMatchObject({ state: 'queued' });
        expect(afterResume).not.toHaveProperty('failure');
        expect(afterResume).not.toHaveProperty('resumable');
        expect(afterResume.messages.at(-1)).toMatchObject({
          role: 'operator',
          kind: 'answer',
          text: 'Continue where you stopped.',
        });
        expectProblem(await resume(run.id), 409, PROBLEM.runNotResumable);

        expect((await claim(W2)).status).toBe(204);
        const claimed = await claim(W1);
        expect(claimed.body).toMatchObject({
          runId: run.id,
          kind: 'resume',
          sessionRef: 'session-9',
          answer: 'Continue where you stopped.',
          runBranch: WORKING_COPY.runBranch,
          // The stopped step was never reported: the resumed one takes its number.
          completedSteps: 0,
        });
        await report(run.id, { state: 'running' });
        expect(
          (
            await worker(`${run.id}/steps`, {
              workerId: W1,
              index: 1,
              kind: 'resume',
              result: { outcome: 'done', summary: 'Done.' },
              workingCopy: WORKING_COPY,
            })
          ).status,
        ).toBe(204);
        await report(run.id, { state: 'succeeded', delivery: { outcome: 'none' } });
        expect((await getRun(run.id)).body.state).toBe('succeeded');
      });

      it("refuses with 409 while another Run holds the project's place", async () => {
        const project = await readyProject('Shop');
        const run = await limitedRun(project.id);
        // The project is free again: another Run starts and is claimed.
        const other = await queuedRun(project.id, 'Another task');
        expect((await claim()).body.runId).toBe(other.id);

        const refused = await resume(run.id);
        expectProblem(refused, 409, PROBLEM.resumeSlotTaken);
        expect(refused.body.detail).toBe(
          'Another run of this project is active. Resume this run when that run has ended.',
        );
        expect((await getRun(run.id)).body).toMatchObject({ state: 'failed', resumable: true });

        await report(other.id, { state: 'running' });
        await report(other.id, { state: 'failed', failure: { code: 'agent_failed', detail: 'x' } });
        expect((await resume(run.id)).status).toBe(202);
      });

      it('refuses a Run without a session, another failure, and a foreign Origin', async () => {
        const project = await readyProject('Shop');
        const noSession = await limitedRun(project.id, null);
        expect((await getRun(noSession.id)).body).not.toHaveProperty('resumable');
        expectProblem(await resume(noSession.id), 409, PROBLEM.runNotResumable);

        const other = await readyProject('Other');
        const run = await queuedRun(other.id);
        await claim();
        await report(run.id, { state: 'running' });
        // A session reference with any other failure is refused by the protocol.
        expect(
          (
            await report(run.id, {
              state: 'failed',
              failure: { code: 'agent_failed', detail: 'x' },
              sessionRef: 'session-9',
            })
          ).status,
        ).toBe(400);
        await report(run.id, { state: 'failed', failure: { code: 'agent_failed', detail: 'x' } });
        expectProblem(await resume(run.id), 409, PROBLEM.runNotResumable);
        expect((await resume(randomUUID())).status).toBe(404);
        expect((await resume(noSession.id, 'https://evil.example.test')).status).toBe(403);
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
          { ...services.config, dataDir: createTestDataDir(), workerToken: null },
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

  describe('Follow-ups', () => {
    const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
    const C1 = 'c'.repeat(40);
    const C2 = 'd'.repeat(40);
    const DONE = {
      outcome: 'done',
      summary: 'Added GET /health.',
      sessionRef: 'session-7',
    };
    const followUp = (runId: string, body: unknown, origin: string | null = STUDIO_ORIGIN) => {
      const call = http().post(`/api/runs/${runId}/follow-up`).set('Cookie', cookie);
      if (origin !== null) call.set('Origin', origin);
      return call.send(body as object);
    };
    const step = (
      runId: string,
      index: number,
      kind: 'start' | 'resume',
      result: object,
      workingCopy: object = WORKING_COPY,
      workerId = W1,
    ) => worker(`${runId}/steps`, { workerId, index, kind, result, workingCopy });

    /** W1 carries a Run of a new project through one done step to `delivered` with its pull request. */
    async function deliveredRun() {
      const project = await readyProject(`Shop ${randomUUID()}`);
      const run = await queuedRun(project.id);
      expect((await claim()).body.kind).toBe('start');
      await report(run.id, { state: 'running' });
      expect((await step(run.id, 1, 'start', DONE)).status).toBe(204);
      const delivered = await report(run.id, {
        state: 'succeeded',
        delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST, pushedCommit: C1 },
      });
      expect(delivered.status).toBe(204);
      return { project, run };
    }

    it('reopens a delivered Run: same session, same Working copy, same pull request', async () => {
      const { run } = await deliveredRun();
      const before = (await getRun(run.id)).body;
      expect(before).toMatchObject({
        state: 'succeeded',
        followUp: { allowed: true },
        followUps: 0,
        steps: { used: 1, usedInPart: 1 },
        commits: [{ id: C1, subject: 'Add GET /health', pushed: true }],
      });

      advance(60);
      const sent = await followUp(run.id, { text: '  Also handle HEAD requests.  ' });
      expect(sent.status).toBe(202);
      expect(sent.body).toEqual({});
      const afterSend = (await getRun(run.id)).body;
      expect(afterSend).toMatchObject({
        state: 'queued',
        followUps: 1,
        followUp: { allowed: false, reason: 'follow_up_queued' },
        pullRequest: PULL_REQUEST,
      });
      expect(afterSend).not.toHaveProperty('finishedAt');
      expect(afterSend).not.toHaveProperty('delivery');
      expect(afterSend.messages.at(-1)).toEqual({
        role: 'operator',
        kind: 'follow_up',
        text: 'Also handle HEAD requests.',
        at: clock.current.toISOString(),
      });
      // A second submission while one is queued is refused clearly.
      const second = await followUp(run.id, { text: 'And OPTIONS.' });
      expectProblem(second, 409, PROBLEM.followUpNotAllowed);
      expect(second.body.detail).toBe(
        'A Follow-up is already queued for this run. Wait until it has finished.',
      );
      // The lists show the Run as active and that it has had a Follow-up.
      const [listed] = (await http().get('/api/runs').set('Cookie', cookie)).body;
      expect(listed).toMatchObject({ id: run.id, state: 'queued', followUps: 1 });
      expect((await http().get('/api/runs/summary').set('Cookie', cookie)).body).toEqual({
        running: 1,
        waiting: 0,
      });

      // Only the agent worker that holds the Working copy and the session resumes it.
      expect((await claim(W2)).status).toBe(204);
      const claimed = await claim(W1);
      expect(claimed.body).toMatchObject({
        runId: run.id,
        kind: 'resume',
        resumeReason: 'follow_up',
        followUpNumber: 1,
        answer: 'Also handle HEAD requests.',
        sessionRef: 'session-7',
        runBranch: WORKING_COPY.runBranch,
        completedSteps: 1,
        stepsBeforePart: 1,
        pullRequestNumber: 7,
      });
      await report(run.id, { state: 'running' });
      const twoCommits = {
        ...WORKING_COPY,
        commits: [...WORKING_COPY.commits, { id: C2, subject: 'Handle HEAD' }],
      };
      // Committed in the Working copy, not pushed yet: the page tells the two apart.
      expect((await step(run.id, 2, 'resume', DONE, twoCommits)).status).toBe(204);
      expect((await getRun(run.id)).body.commits).toEqual([
        { id: C1, subject: 'Add GET /health', pushed: true },
        { id: C2, subject: 'Handle HEAD', pushed: false },
      ]);
      expect(
        (
          await report(run.id, {
            state: 'succeeded',
            delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST, pushedCommit: C2 },
          })
        ).status,
      ).toBe(204);

      const after = (await getRun(run.id)).body;
      expect(after).toMatchObject({
        state: 'succeeded',
        delivery: 'delivered',
        pullRequest: PULL_REQUEST,
        followUps: 1,
        steps: { used: 2, usedInPart: 1 },
        limits: { maxSteps: LIMITS.maxSteps, maxTotalSteps: LIMITS.maxTotalSteps },
        commits: [
          { id: C1, subject: 'Add GET /health', pushed: true },
          { id: C2, subject: 'Handle HEAD', pushed: true },
        ],
      });
      // The earlier result stays in the conversation; the state reflects the latest one.
      expect(after.messages.map((message: { kind: string }) => message.kind)).toEqual([
        'task',
        'part_end',
        'follow_up',
      ]);
      expect(after.messages[1]).toMatchObject({
        role: 'studio',
        kind: 'part_end',
        end: { state: 'succeeded', delivery: 'delivered' },
      });
      expect(JSON.stringify(after)).not.toContain('session-7');
    });

    // A request to bring the Run branch up to date is a Follow-up of its own source.
    describe('bringing the branch up to date', () => {
      const MERGED = 'e'.repeat(40);
      const bringUp = (runId: string, body?: unknown, origin: string | null = STUDIO_ORIGIN) => {
        const call = http().post(`/api/runs/${runId}/bring-up-to-date`).set('Cookie', cookie);
        if (origin !== null) call.set('Origin', origin);
        return body === undefined ? call.send() : call.send(body as object);
      };

      it('queues the Run with its note, hands the claim the reason and records the merged commit', async () => {
        const { run } = await deliveredRun();
        advance(60);

        const sent = await bringUp(run.id, { note: '  Keep our config.  ' });

        expect(sent.status).toBe(202);
        expect(sent.body).toEqual({});
        const afterSend = (await getRun(run.id)).body;
        expect(afterSend).toMatchObject({
          state: 'queued',
          followUps: 1,
          followUp: { allowed: false, reason: 'follow_up_queued' },
          pullRequest: PULL_REQUEST,
        });
        expect(afterSend.messages.at(-1)).toEqual({
          role: 'operator',
          kind: 'follow_up',
          text: 'Keep our config.',
          source: 'bring_up_to_date',
          at: clock.current.toISOString(),
        });
        // A second request, or a plain Follow-up, while one is queued is refused clearly.
        expectProblem(await bringUp(run.id), 409, PROBLEM.followUpNotAllowed);
        expectProblem(await followUp(run.id, { text: 'More.' }), 409, PROBLEM.followUpNotAllowed);

        expect((await claim(W2)).status).toBe(204);
        expect((await claim(W1)).body).toMatchObject({
          runId: run.id,
          kind: 'resume',
          resumeReason: 'bring_up_to_date',
          bringUpToDate: true,
          followUpNumber: 1,
          answer: 'Keep our config.',
          sessionRef: 'session-7',
          pullRequestNumber: 7,
          stepsBeforePart: 1,
        });
        // Where the merge started is kept by Studio; the page shows a merged commit only once the
        // part succeeded and delivered.
        expect(
          (
            await report(run.id, {
              state: 'running',
              bringUpToDateStarted: { baseCommit: C1, integrationCommit: MERGED },
            })
          ).status,
        ).toBe(204);
        expect((await getRun(run.id)).body.messages.at(-1)).not.toHaveProperty('mergedCommit');
        expect((await step(run.id, 2, 'resume', DONE)).status).toBe(204);
        expect(
          (
            await report(run.id, {
              state: 'succeeded',
              delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST, pushedCommit: C2 },
            })
          ).status,
        ).toBe(204);
        const after = (await getRun(run.id)).body;
        expect(after).toMatchObject({
          state: 'succeeded',
          delivery: 'delivered',
          steps: { used: 2, usedInPart: 1 },
        });
        expect(after.messages.at(-1)).toMatchObject({
          source: 'bring_up_to_date',
          mergedCommit: MERGED,
        });
        // The next claim counts the Run's own changes from the commit it merged.
        expect((await followUp(run.id, { text: 'One more thing.' })).status).toBe(202);
        const next = (await claim()).body;
        expect(next).toMatchObject({ resumeReason: 'follow_up', mergedIntegrationCommit: MERGED });
        expect(next).not.toHaveProperty('bringUpToDate');
      });

      it('hands the next part the base of a bring-up part that failed, and the retry its merged commit', async () => {
        const { run } = await deliveredRun();
        await bringUp(run.id);
        await claim();
        await report(run.id, {
          state: 'running',
          bringUpToDateStarted: { baseCommit: C1, integrationCommit: MERGED },
        });
        await step(run.id, 2, 'resume', DONE);
        // The merge was made, the delivery failed: its retry counts from the merged commit.
        await report(run.id, {
          state: 'failed',
          failure: { code: 'delivery_failed', detail: 'Pushing was refused.' },
        });
        await http()
          .post(`/api/runs/${run.id}/retry-delivery`)
          .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
          .send();
        const retry = (await claim()).body;
        expect(retry).toMatchObject({ kind: 'deliver', mergedIntegrationCommit: MERGED });
        expect(retry).not.toHaveProperty('pendingUpdate');
        await report(run.id, {
          state: 'failed',
          failure: { code: 'delivery_failed', detail: 'Pushing was refused again.' },
        });

        // A plain Follow-up is a new part: it starts by undoing what the earlier one left.
        expect((await followUp(run.id, { text: 'Go on without it.' })).status).toBe(202);
        expect((await claim()).body).toMatchObject({
          resumeReason: 'follow_up',
          pendingUpdate: { baseCommit: C1 },
        });
      });

      it('hands every claim of the part where the merge started, until the part is over', async () => {
        const { run } = await deliveredRun();
        await bringUp(run.id);
        await claim();
        await report(run.id, {
          state: 'running',
          bringUpToDateStarted: { baseCommit: C1, integrationCommit: MERGED },
        });
        // The agent asks mid-part: the answer resumes the same part, with the same knowledge.
        await step(run.id, 2, 'resume', {
          ...DONE,
          outcome: 'needs_input',
          question: { text: 'Which side?' },
        });
        await report(run.id, { state: 'waiting_for_operator' });
        await http()
          .post(`/api/runs/${run.id}/answer`)
          .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
          .send({ text: 'Ours' });

        expect((await claim()).body).toMatchObject({
          resumeReason: 'answer',
          bringUpToDate: true,
          updateBase: C1,
          updateTip: MERGED,
        });
      });

      it('holds a bring-up request back while the concurrency limit is full, like a Follow-up', async () => {
        const { run } = await deliveredRun();
        await bringUp(run.id);
        // Two other projects fill the server's places before this one is claimed.
        const first = await readyProject(`Shop ${randomUUID()}`);
        const second = await readyProject(`Shop ${randomUUID()}`);
        await queuedRun(first.id, 'First');
        await queuedRun(second.id, 'Second');
        expect((await claim(W2)).body).toMatchObject({ kind: 'start', task: 'First' });
        expect((await claim(W2)).body).toMatchObject({ kind: 'start', task: 'Second' });

        expect((await claim(W1)).status).toBe(204);
        expect((await getRun(run.id)).body.state).toBe('queued');
      });

      it('takes no note, and gives the claim a default text', async () => {
        const { run } = await deliveredRun();

        const sent = await bringUp(run.id);

        expect(sent.status).toBe(202);
        expect(sent.body).toEqual({});
        const afterSend = (await getRun(run.id)).body;
        expect(afterSend.messages.at(-1)).toMatchObject({
          kind: 'follow_up',
          text: '',
          source: 'bring_up_to_date',
        });
        expect((await claim()).body).toMatchObject({
          resumeReason: 'bring_up_to_date',
          answer: 'Bring the Run branch up to date.',
        });
      });

      it('returns the Run to its earlier result when the branch was already up to date', async () => {
        const { run } = await deliveredRun();
        await bringUp(run.id, { note: 'Please.' });
        await claim();

        expect((await report(run.id, { state: 'succeeded', unchanged: true })).status).toBe(204);

        const after = (await getRun(run.id)).body;
        expect(after).toMatchObject({
          state: 'succeeded',
          delivery: 'delivered',
          pullRequest: PULL_REQUEST,
          followUp: { allowed: true },
          steps: { used: 1 },
        });
        expect(after.messages.map((message: { kind: string }) => message.kind)).toEqual([
          'task',
          'part_end',
          'follow_up',
          'part_end',
        ]);
        expect(after.messages.at(-1)).toMatchObject({
          role: 'studio',
          kind: 'part_end',
          end: { state: 'succeeded', delivery: 'delivered' },
          text: expect.stringContaining('already has everything'),
        });
        expect(after.messages.at(-2)).not.toHaveProperty('mergedCommit');
        // The worker's retry of the same report changes nothing, and another request works.
        expect((await report(run.id, { state: 'succeeded', unchanged: true })).status).toBe(204);
        expect((await bringUp(run.id)).status).toBe(202);
      });

      it('fails a request whose integration branch could not be fetched, keeping the earlier result in the conversation', async () => {
        const { run } = await deliveredRun();
        await bringUp(run.id);
        await claim();

        expect(
          (
            await report(run.id, {
              state: 'failed',
              failure: {
                code: 'preparation_failed',
                detail: 'The integration branch dev could not be fetched.',
              },
            })
          ).status,
        ).toBe(204);

        const after = (await getRun(run.id)).body;
        expect(after).toMatchObject({
          state: 'failed',
          failure: { code: 'preparation_failed' },
          followUp: { allowed: true },
        });
        expect(after.messages.map((message: { kind: string }) => message.kind)).toEqual([
          'task',
          'part_end',
          'follow_up',
        ]);
        expect(after.messages[1]).toMatchObject({ end: { state: 'succeeded' } });
      });

      it('refuses what a Follow-up refuses, a bad note, an unknown Run and a missing session or origin', async () => {
        const { run } = await deliveredRun();
        expectProblem(await bringUp(run.id, { note: 'a'.repeat(10_001) }), 422);
        expectProblem(await bringUp(run.id, { note: 'ok', extra: true }), 422);
        expectProblem(await bringUp(randomUUID()), 404, PROBLEM.runNotFound);
        expectProblem(await bringUp('nope'), 404, PROBLEM.runNotFound);
        expect((await bringUp(run.id, undefined, 'https://evil.example.test')).status).toBe(403);
        const withoutSession = await http()
          .post(`/api/runs/${run.id}/bring-up-to-date`)
          .set('Origin', STUDIO_ORIGIN)
          .send();
        expect(withoutSession.status).toBe(401);
        expect((await getRun(run.id)).body.state).toBe('succeeded');
        expect((await bringUp(run.id, { note: 'a'.repeat(10_000) })).status).toBe(202);

        // A Run that is not finished takes none, as with a Follow-up.
        const project = await readyProject(`Shop ${randomUUID()}`);
        const working = await queuedRun(project.id);
        expectProblem(await bringUp(working.id), 409, PROBLEM.followUpNotAllowed);
      });

      it('refuses the already-up-to-date report for a Run that is not carrying such a request', async () => {
        const project = await readyProject(`Shop ${randomUUID()}`);
        const plain = await queuedRun(project.id);
        await claim();
        await report(plain.id, { state: 'running' });

        const refused = await report(plain.id, { state: 'succeeded', unchanged: true });

        expectProblem(refused, 409, PROBLEM.illegalRunTransition);
        expect((await getRun(plain.id)).body.state).toBe('running');
      });
    });

    it.each([
      ['failed', { state: 'failed', failure: { code: 'agent_failed', detail: 'It broke.' } }],
      ['timed_out', { state: 'timed_out' }],
    ])('takes a Follow-up on a %s Run', async (_state, end) => {
      const project = await readyProject(`Shop ${randomUUID()}`);
      const run = await queuedRun(project.id);
      await claim();
      await report(run.id, { state: 'running' });
      await step(run.id, 1, 'start', { ...DONE, outcome: 'needs_input', question: { text: 'Q?' } });
      await report(run.id, { state: 'waiting_for_operator' });
      // Refused while the Run waits for the operator.
      expectProblem(await followUp(run.id, { text: 'x' }), 409, PROBLEM.followUpNotAllowed);
      await http()
        .post(`/api/runs/${run.id}/answer`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
        .send({ text: 'Yes' });
      await claim();
      await report(run.id, { state: 'running' });
      expect((await report(run.id, { ...end, workingCopy: WORKING_COPY })).status).toBe(204);

      const sent = await followUp(run.id, { text: 'Try again, smaller.' });
      expect(sent.status).toBe(202);
      expect(sent.body).toEqual({});
      const afterSend = (await getRun(run.id)).body;
      expect(afterSend).toMatchObject({ state: 'queued' });
      expect(afterSend).not.toHaveProperty('failure');
    });

    it('takes a Follow-up on a cancelled Run, and a queued Follow-up can be cancelled', async () => {
      const project = await readyProject(`Shop ${randomUUID()}`);
      const run = await queuedRun(project.id);
      await claim();
      await report(run.id, { state: 'running' });
      await step(run.id, 1, 'start', { ...DONE, outcome: 'needs_input', question: { text: 'Q?' } });
      await report(run.id, { state: 'waiting_for_operator' });
      const cancel = () =>
        http().post(`/api/runs/${run.id}/cancel`).set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
      expect((await cancel()).body).toEqual({ outcome: 'cancelled' });

      expect((await followUp(run.id, { text: 'Go on after all.' })).status).toBe(202);
      const cancelled = await cancel();
      expect(cancelled.body).toEqual({ outcome: 'cancelled' });
      expect((await getRun(run.id)).body).toMatchObject({ state: 'cancelled', followUps: 1 });
      // Cancelled before it was claimed: nothing is handed out, and it can be followed up again.
      expect((await claim()).status).toBe(204);
      expect((await getRun(run.id)).body.followUp).toEqual({
        allowed: true,
        openUntil: expect.any(String),
      });
    });

    it('refuses a Run that is queued, preparing or running, or has no session (409)', async () => {
      const project = await readyProject(`Shop ${randomUUID()}`);
      const run = await queuedRun(project.id);
      expectProblem(await followUp(run.id, { text: 'x' }), 409, PROBLEM.followUpNotAllowed);
      await claim();
      expectProblem(await followUp(run.id, { text: 'x' }), 409, PROBLEM.followUpNotAllowed);
      await report(run.id, { state: 'running' });
      const running = await followUp(run.id, { text: 'x' });
      expectProblem(running, 409, PROBLEM.followUpNotAllowed);
      expect(running.body.detail).toBe(
        'The run is still working or waiting for you. Send a Follow-up once it has finished.',
      );
      // Failed before any step reported a session: nothing to continue.
      await report(run.id, { state: 'failed', failure: { code: 'agent_failed', detail: 'x' } });
      expect((await getRun(run.id)).body.followUp).toEqual({
        allowed: false,
        reason: 'no_session',
      });
      expectProblem(await followUp(run.id, { text: 'x' }), 409, PROBLEM.followUpNotAllowed);
    });

    it('validates the text (422), finds the Run (404) and guards the session and origin', async () => {
      const { run } = await deliveredRun();
      expectProblem(await followUp(run.id, { text: '   ' }), 422);
      expectProblem(await followUp(run.id, { text: 'a'.repeat(10_001) }), 422);
      expectProblem(await followUp(run.id, { text: 'x', extra: true }), 422);
      expectProblem(await followUp(randomUUID(), { text: 'x' }), 404, PROBLEM.runNotFound);
      expectProblem(await followUp('nope', { text: 'x' }), 404, PROBLEM.runNotFound);
      expect((await followUp(run.id, { text: 'x' }, 'https://evil.example')).status).toBe(403);
      const anonymous = await http()
        .post(`/api/runs/${run.id}/follow-up`)
        .set('Origin', STUDIO_ORIGIN)
        .send({ text: 'x' });
      expect(anonymous.status).toBe(401);
      expect((await followUp(run.id, { text: 'a'.repeat(10_000) })).status).toBe(202);
    });

    it('gives each Follow-up its own Run step allowance and stops at the Run step total', async () => {
      // LIMITS: 2 Run steps per part, 3 in total.
      const { run } = await deliveredRun();
      expect((await followUp(run.id, { text: 'Next.' })).status).toBe(202);
      expect((await claim()).body).toMatchObject({ completedSteps: 1, stepsBeforePart: 1 });
      await report(run.id, { state: 'running' });
      expect(
        (
          await step(run.id, 2, 'resume', {
            ...DONE,
            outcome: 'needs_input',
            question: { text: 'Q?' },
          })
        ).status,
      ).toBe(204);
      await report(run.id, { state: 'waiting_for_operator' });
      await http()
        .post(`/api/runs/${run.id}/answer`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
        .send({ text: 'Yes' });
      // A Question inside a Follow-up: the answer resumes it, still Follow-up 1.
      expect((await claim()).body).toMatchObject({
        resumeReason: 'answer',
        followUpNumber: 1,
        completedSteps: 2,
        stepsBeforePart: 1,
      });
      await report(run.id, { state: 'running' });
      expect((await step(run.id, 3, 'resume', DONE)).status).toBe(204);
      await report(run.id, {
        state: 'succeeded',
        delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
      });

      // Three Run steps in total: no further Follow-up.
      expect((await getRun(run.id)).body).toMatchObject({
        steps: { used: 3, usedInPart: 2 },
        followUp: { allowed: false, reason: 'step_total_reached' },
      });
      const refused = await followUp(run.id, { text: 'One more.' });
      expectProblem(refused, 409, PROBLEM.followUpNotAllowed);
      expect(refused.body.detail).toBe(
        'The run has used all the run steps it may take in total. Start a new run instead.',
      );
    });

    it('fails a Follow-up step beyond its own allowance with step_limit', async () => {
      const { run } = await deliveredRun();
      await followUp(run.id, { text: 'Next.' });
      await claim();
      await report(run.id, { state: 'running' });
      // Steps 2 and 3 are the Follow-up's two; step 4 would be its third.
      await step(run.id, 2, 'resume', {
        ...DONE,
        outcome: 'needs_input',
        question: { text: 'Q?' },
      });
      await report(run.id, { state: 'waiting_for_operator' });
      await http()
        .post(`/api/runs/${run.id}/answer`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
        .send({ text: 'Yes' });
      await claim();
      await report(run.id, { state: 'running' });
      await step(run.id, 3, 'resume', {
        ...DONE,
        outcome: 'needs_input',
        question: { text: 'Q?' },
      });
      await report(run.id, { state: 'waiting_for_operator' });
      await http()
        .post(`/api/runs/${run.id}/answer`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
        .send({ text: 'Yes' });
      await claim();
      await report(run.id, { state: 'running' });
      expectProblem(await step(run.id, 4, 'resume', DONE), 409, PROBLEM.stepLimitReached);
      expect((await getRun(run.id)).body).toMatchObject({
        state: 'failed',
        failure: {
          code: 'step_limit',
          detail: 'The Follow-up reached its limit of 2 run steps; no further step was started.',
        },
        // A failed Follow-up keeps the Run's pull request; nothing new was pushed.
        pullRequest: PULL_REQUEST,
      });
    });

    it('waits in the queue under the concurrency limits and starts once its project is free', async () => {
      const { project, run } = await deliveredRun();
      const other = await queuedRun(project.id, 'Another task');
      expect((await claim(W2)).body.runId).toBe(other.id);

      expect((await followUp(run.id, { text: 'Next.' })).status).toBe(202);
      // The project's place is taken: the Follow-up waits, holding no place of its own.
      expect((await claim(W1)).status).toBe(204);
      await report(other.id, { state: 'running' }, W2);
      await report(
        other.id,
        { state: 'failed', failure: { code: 'agent_failed', detail: 'x' } },
        W2,
      );
      expect((await claim(W1)).body).toMatchObject({ runId: run.id, resumeReason: 'follow_up' });
    });

    it('records a cancel, a failure and a time-out during a Follow-up, keeping the pull request', async () => {
      for (const end of ['cancelled', 'failed', 'timed_out'] as const) {
        const { run } = await deliveredRun();
        await followUp(run.id, { text: 'Next.' });
        await claim();
        await report(run.id, { state: 'running' });
        if (end === 'cancelled') {
          await http()
            .post(`/api/runs/${run.id}/cancel`)
            .set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
          expect((await heartbeat(run.id)).body).toEqual({ cancelRequested: true });
        }
        const body =
          end === 'failed'
            ? {
                state: end,
                failure: { code: 'agent_failed', detail: 'x' },
                workingCopy: WORKING_COPY,
              }
            : { state: end, workingCopy: WORKING_COPY };
        expect((await report(run.id, body)).status).toBe(204);
        const ended = (await getRun(run.id)).body;
        expect(ended).toMatchObject({ state: end, pullRequest: PULL_REQUEST, followUps: 1 });
        expect(ended).not.toHaveProperty('delivery');
        // Its commits stay in the Working copy, and a further Follow-up can continue from them.
        expect(ended.followUp).toEqual({
          allowed: true,
          openUntil: expect.any(String),
        });
      }
    });

    it('opens the first pull request from a Follow-up of a Run that had none', async () => {
      const project = await readyProject(`Shop ${randomUUID()}`);
      const run = await queuedRun(project.id);
      await claim();
      await report(run.id, { state: 'running' });
      await step(run.id, 1, 'start', DONE, { ...WORKING_COPY, commits: [] });
      await report(run.id, { state: 'succeeded', delivery: { outcome: 'none' } });

      await followUp(run.id, { text: 'Now change something.' });
      const claimed = await claim();
      expect(claimed.body).not.toHaveProperty('pullRequestNumber');
      await report(run.id, { state: 'running' });
      await step(run.id, 2, 'resume', DONE);
      await report(run.id, {
        state: 'succeeded',
        delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST, pushedCommit: C1 },
      });
      expect((await getRun(run.id)).body).toMatchObject({
        delivery: 'delivered',
        pullRequest: PULL_REQUEST,
      });
    });

    // How a part ended stays in the conversation after a Follow-up.
    it("keeps each part's end in the conversation: state, failure and delivery", async () => {
      const project = await readyProject(`Shop ${randomUUID()}`);
      const run = await queuedRun(project.id);
      await claim();
      await report(run.id, { state: 'running' });
      await step(run.id, 1, 'start', DONE);
      await report(run.id, {
        state: 'failed',
        failure: { code: 'agent_failed', detail: 'The tests did not compile.' },
        workingCopy: WORKING_COPY,
      });

      const sent = await followUp(run.id, { text: 'Fix the compile error.' });
      expect(sent.status).toBe(202);
      expect(sent.body).toEqual({});
      const afterSend = (await getRun(run.id)).body;
      expect(afterSend.messages.slice(1)).toEqual([
        {
          role: 'studio',
          kind: 'part_end',
          text: 'The tests did not compile.',
          end: { state: 'failed', failureCode: 'agent_failed' },
          at: expect.stringMatching(ISO_8601),
        },
        {
          role: 'operator',
          kind: 'follow_up',
          text: 'Fix the compile error.',
          at: expect.stringMatching(ISO_8601),
        },
      ]);
      expect(afterSend).not.toHaveProperty('failure');
    });

    // A delivery that pushed before it failed still records the push.
    it('records the pushed commit of a delivery that failed after its push', async () => {
      const { run } = await deliveredRun();
      await followUp(run.id, { text: 'Next.' });
      await claim();
      await report(run.id, { state: 'running' });
      const twoCommits = {
        ...WORKING_COPY,
        commits: [...WORKING_COPY.commits, { id: C2, subject: 'Handle HEAD' }],
      };
      await step(run.id, 2, 'resume', DONE, twoCommits);
      const failed = await report(run.id, {
        state: 'failed',
        failure: { code: 'delivery_failed', detail: 'Updating the pull request was refused.' },
        pushedCommit: C2,
      });
      expect(failed.status).toBe(204);
      expect((await getRun(run.id)).body).toMatchObject({
        state: 'failed',
        delivery: 'failed',
        pullRequest: PULL_REQUEST,
        commits: [
          { id: C1, pushed: true },
          { id: C2, pushed: true },
        ],
      });
    });

    // A removal reported while a Follow-up waits is never dropped.
    it('fails a queued Follow-up whose Working copy was removed meanwhile', async () => {
      const { run } = await deliveredRun();
      expect((await followUp(run.id, { text: 'Next.' })).status).toBe(202);
      await worker('states', { workerId: W1, runIds: [run.id], removedRunIds: [run.id] });

      expect((await claim()).status).toBe(204);
      expect((await getRun(run.id)).body).toMatchObject({
        state: 'failed',
        failure: {
          code: 'preparation_failed',
          detail:
            "Working copy no longer exists — run again: the agent worker's retention removed it.",
        },
        followUp: { allowed: false, reason: 'working_copy_removed' },
      });
    });

    it('fails a queued Follow-up whose agent worker is gone as preparation_failed', async () => {
      const { run } = await deliveredRun();
      expect((await followUp(run.id, { text: 'Next.' })).status).toBe(202);

      const shortLease = await startStudioApp(
        {
          ...services.config,
          dataDir: createTestDataDir(),
          workerToken: WORKER_TOKEN_DIGEST,
          workerLeaseSeconds: 2,
          runLimits: LIMITS,
        },
        { executions: { clock } },
      );
      try {
        advance(3);
        const deadline = Date.now() + 10_000;
        while ((await getRun(run.id)).body.state === 'queued' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      } finally {
        await shortLease.close();
      }
      expect((await getRun(run.id)).body).toMatchObject({
        state: 'failed',
        failure: { code: 'preparation_failed' },
      });
    });

    it('resumes a Follow-up stopped at the usage limit, with a new Environment file snapshot', async () => {
      const { run } = await deliveredRun();
      await followUp(run.id, { text: 'Next.' });
      expect((await claim()).body).toMatchObject({ replaceEnvironmentFile: true, studioPaths: [] });
      await report(run.id, { state: 'running' });
      await report(run.id, {
        state: 'failed',
        failure: { code: 'usage_limit', detail: 'The usage limit was reached.' },
        workingCopy: WORKING_COPY,
        sessionRef: 'session-7',
      });

      const resumed = await http()
        .post(`/api/runs/${run.id}/resume`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
      expect(resumed.status).toBe(202);
      expect((await claim()).body).toMatchObject({
        kind: 'resume',
        resumeReason: 'usage_limit',
        followUpNumber: 1,
        replaceEnvironmentFile: true,
        answer: 'Continue where you stopped.',
      });
    });

    it('counts toward the server-wide limit only once claimed', async () => {
      const { run } = await deliveredRun();
      // Two other projects take both places on the server.
      const a = await queuedRun((await readyProject(`A ${randomUUID()}`)).id);
      const b = await queuedRun((await readyProject(`B ${randomUUID()}`)).id);
      expect((await claim(W2)).body.runId).toBe(a.id);
      expect((await claim(W2)).body.runId).toBe(b.id);

      expect((await followUp(run.id, { text: 'Next.' })).status).toBe(202);
      expect((await claim(W1)).status).toBe(204);
      await report(a.id, { state: 'running' }, W2);
      await report(a.id, { state: 'failed', failure: { code: 'agent_failed', detail: 'x' } }, W2);
      expect((await claim(W1)).body).toMatchObject({ runId: run.id, resumeReason: 'follow_up' });
    });

    it('records the Working copies retention removed, reported by the worker that holds them', async () => {
      const { run } = await deliveredRun();
      // Another worker cannot report it.
      await worker('states', { workerId: W2, runIds: [run.id], removedRunIds: [run.id] });
      expect((await getRun(run.id)).body.followUp).toEqual({
        allowed: true,
        openUntil: expect.any(String),
      });

      const removed = await worker('states', {
        workerId: W1,
        runIds: [run.id],
        removedRunIds: [run.id],
      });
      expect(removed.status).toBe(200);
      expect((await getRun(run.id)).body.followUp).toEqual({
        allowed: false,
        reason: 'working_copy_removed',
      });
      expectProblem(await followUp(run.id, { text: 'x' }), 409, PROBLEM.followUpNotAllowed);
    });

    it('refuses while the agent worker holding the Working copy is not connected', async () => {
      const { run } = await deliveredRun();
      advance(LEASE_SECONDS + 1);
      // Another worker reports: the Provider is available, but not the Working copy's worker.
      expect((await workerStatus(BOTH_ENABLED, W2)).status).toBe(204);
      expect((await getRun(run.id)).body.followUp).toEqual({
        allowed: false,
        reason: 'worker_unavailable',
        openUntil: expect.any(String),
      });
      expect((await workerStatus({ claude_code: false, codex: true }, W1)).status).toBe(204);
      expect((await getRun(run.id)).body.followUp).toEqual({
        allowed: false,
        reason: 'provider_unavailable',
        openUntil: expect.any(String),
      });
    });
  });
});
