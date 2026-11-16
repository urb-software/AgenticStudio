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

// Issue #142, main seam: the state of a Run's pull request over HTTP on the real app with
// PostgreSQL and Redis from Testcontainers. The operator asks for a refresh; the agent worker's
// side is driven over the worker routes exactly as the worker calls them (claim the lookups,
// report what it read). A controlled clock drives the lease and the retries, so no test waits.

// A throwaway worker token generated per run; no token is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const LEASE_SECONDS = 60;
const LIMITS = { stepMinutes: 60, maxSteps: 5, waitingDays: 14, maxTotalSteps: 20 };
const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
const WORKING_COPY = {
  runBranch: 'agent/add-a-health-check-r0b8e5c2d',
  commits: [{ id: 'c'.repeat(40), subject: 'Add GET /health' }],
  hasUncommittedChanges: false,
};
const PROBLEM = {
  runNotFound: 'urn:agentic-studio:problem:run-not-found',
  followUpNotAllowed: 'urn:agentic-studio:problem:follow-up-not-allowed',
  pullRequestNotRefreshable: 'urn:agentic-studio:problem:pull-request-not-refreshable',
  lookupNotFound: 'urn:agentic-studio:problem:lookup-not-found',
  lookupNotHeld: 'urn:agentic-studio:problem:lookup-not-held',
  lookupKindMismatch: 'urn:agentic-studio:problem:lookup-kind-mismatch',
};

function expectProblem(response: request.Response, status: number, type?: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
  if (type) expect(response.body.type).toBe(type);
}

describe('pull request state API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  let cookie: string;
  const clock = { current: new Date(), now: () => clock.current };
  const advance = (seconds: number) => {
    clock.current = new Date(clock.current.getTime() + seconds * 1000);
  };
  const W1 = randomUUID();
  const W2 = randomUUID();
  /** One pass of the daily refresh, run by hand (the app hands it over instead of a timer). */
  let dailyPass: () => Promise<void>;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const asWorker = (path: string, body: object, token: string | null = WORKER_TOKEN) => {
    const call = http().post(`/api/worker/${path}`);
    if (token !== null) call.set('Authorization', `Bearer ${token}`);
    return call.send(body);
  };
  const getRun = (runId: string) => http().get(`/api/runs/${runId}`).set('Cookie', cookie);
  const refresh = (runId: string, body?: object, headers: object = {}) =>
    http()
      .post(`/api/runs/${runId}/pull-request/refresh`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie, ...headers })
      .send(body ?? {});
  const claimLookups = (workerId = W1, token: string | null = WORKER_TOKEN) =>
    asWorker('lookups/claim', { workerId }, token);
  const answer = (lookupId: string, body: object, token: string | null = WORKER_TOKEN) =>
    asWorker(`lookups/${lookupId}/result`, body, token);
  const read = (result: object, workerId = W1) => ({
    workerId,
    ok: true,
    kind: 'pull_request_state',
    result,
  });
  /** The worker's status report, as it sends one with every poll (Issue #101). */
  const connectWorker = async () => {
    const status = await asWorker('status', {
      workerId: W1,
      runner: 'cli',
      providers: { claude_code: true, codex: true },
    });
    expect(status.status).toBe(204);
  };
  const followUp = (runId: string) =>
    http()
      .post(`/api/runs/${runId}/follow-up`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send({ text: 'Also handle HEAD requests.' });

  /** A Run of a new project carried by W1 through one done step to its draft pull request. */
  async function deliveredRun(options: { delivered?: boolean } = {}) {
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
    expect((await asWorker('runs/claim', { workerId: W1 })).status).toBe(200);
    await asWorker(`runs/${runId}/state`, { workerId: W1, state: 'running' });
    const stepped = await asWorker(`runs/${runId}/steps`, {
      workerId: W1,
      index: 1,
      kind: 'start',
      result: { outcome: 'done', summary: 'Done.', sessionRef: 'session-1' },
      workingCopy: WORKING_COPY,
    });
    expect(stepped.status).toBe(204);
    const ended = await asWorker(`runs/${runId}/state`, {
      workerId: W1,
      state: 'succeeded',
      delivery:
        options.delivered === false
          ? { outcome: 'none' }
          : { outcome: 'delivered', pullRequest: PULL_REQUEST },
    });
    expect(ended.status).toBe(204);
    return runId;
  }

  /** Claims W1's one waiting lookup and answers it with `result`. */
  async function readAs(result: object) {
    const claimed = await claimLookups();
    expect(claimed.status).toBe(200);
    expect(claimed.body).toHaveLength(1);
    const lookupId = claimed.body[0].id as string;
    expect((await answer(lookupId, read(result))).status).toBe(204);
    return lookupId;
  }

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(
      {
        ...services.config,
        workerToken: WORKER_TOKEN_DIGEST,
        workerLeaseSeconds: LEASE_SECONDS,
        runLimits: LIMITS,
      },
      { executions: { clock, pullRequestRefresh: { manual: (pass) => (dailyPass = pass) } } },
    );
    cookie = await signIn(app);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  beforeEach(async () => {
    // Test isolation only; CASCADE also empties runs and run_lookups.
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    await db().$executeRaw`TRUNCATE TABLE run_lease_renewals`;
    clock.current = new Date();
    await connectWorker();
  });

  describe('refresh', () => {
    it('records a request: the Run shows it is refreshing, and a worker claims it', async () => {
      const runId = await deliveredRun();
      expect((await getRun(runId)).body.pullRequest).toEqual(PULL_REQUEST);

      const asked = await refresh(runId);

      expect(asked.status).toBe(202);
      expect(asked.body.pullRequest).toEqual({ ...PULL_REQUEST, refreshing: true });
      const claimed = await claimLookups();
      expect(claimed.status).toBe(200);
      expect(claimed.body).toEqual([
        {
          id: expect.any(String),
          kind: 'pull_request_state',
          runId,
          repository: { remoteUrl: expect.stringMatching(/^https:\/\/github\.com\/acme\//) },
          pullRequestNumber: 7,
          runBranch: WORKING_COPY.runBranch,
          integrationBranch: 'dev',
        },
      ]);
    });

    it('keeps one open lookup per Run, however often it is asked', async () => {
      const runId = await deliveredRun();

      await refresh(runId);
      await refresh(runId);
      await refresh(runId, { onOpen: true });

      const count = await db().$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM run_lookups WHERE run_id = ${runId}::uuid`;
      expect(Number(count[0]!.count)).toBe(1);
    });

    it('asks at most once a minute when the Run page opens, and any time for the Refresh action', async () => {
      const runId = await deliveredRun();
      await refresh(runId);
      await readAs({ state: 'draft', behindBy: 0, aheadBy: 1 });

      advance(30);
      const early = await refresh(runId, { onOpen: true });
      expect(early.status).toBe(202);
      expect(early.body.pullRequest).not.toHaveProperty('refreshing');
      expect((await claimLookups()).status).toBe(204);

      advance(31);
      // The worker reports itself with every poll: it is still connected a minute later.
      await connectWorker();
      expect((await refresh(runId, { onOpen: true })).body.pullRequest.refreshing).toBe(true);
      await readAs({ state: 'draft' });

      // The Refresh action is not held back by the minute.
      const again = await refresh(runId);
      expect(again.body.pullRequest.refreshing).toBe(true);
    });

    it('says no agent worker is connected while a refresh waits and none reported', async () => {
      const runId = await deliveredRun();
      await refresh(runId);

      advance(LEASE_SECONDS + 1);
      const run = await getRun(runId);

      expect(run.body.pullRequest).not.toHaveProperty('refreshing');
      expect(run.body.pullRequest.refreshError).toMatch(/agent worker is not connected/);
    });

    it('records one lookup when many refreshes arrive at once (review S6 of #152)', async () => {
      const runId = await deliveredRun();

      const answers = await Promise.all(Array.from({ length: 6 }, () => refresh(runId)));

      expect(answers.every((answer) => answer.status === 202)).toBe(true);
      const count = await db().$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM run_lookups WHERE run_id = ${runId}::uuid`;
      expect(Number(count[0]!.count)).toBe(1);
    });

    it('does not ask again on opening within a minute of a failed lookup, and does after it (review S1 of #152)', async () => {
      const runId = await deliveredRun();
      await refresh(runId, { onOpen: true });
      const id = (await claimLookups()).body[0].id as string;
      await answer(id, {
        workerId: W1,
        ok: false,
        code: 'failed',
        error: 'GitHub could not be reached.',
      });
      const lookupCount = async () => {
        const rows = await db().$queryRaw<{ count: bigint }[]>`
          SELECT count(*) FROM run_lookups WHERE run_id = ${runId}::uuid`;
        return Number(rows[0]!.count);
      };

      advance(30);
      await refresh(runId, { onOpen: true });
      await refresh(runId, { onOpen: true });
      expect(await lookupCount()).toBe(1);

      advance(31);
      await refresh(runId, { onOpen: true });
      expect(await lookupCount()).toBe(2);
    });

    it('answers 409 for a Run without a pull request, 404 for an unknown Run', async () => {
      const runId = await deliveredRun({ delivered: false });

      expectProblem(await refresh(runId), 409, PROBLEM.pullRequestNotRefreshable);
      expectProblem(await refresh(randomUUID()), 404, PROBLEM.runNotFound);
      expectProblem(await refresh('nope'), 404, PROBLEM.runNotFound);
    });

    it('needs the operator session and the Origin check, and refuses an invalid body', async () => {
      const runId = await deliveredRun();

      const anonymous = await http()
        .post(`/api/runs/${runId}/pull-request/refresh`)
        .set({ Origin: STUDIO_ORIGIN })
        .send({});
      expect(anonymous.status).toBe(401);
      const foreign = await http()
        .post(`/api/runs/${runId}/pull-request/refresh`)
        .set({ Origin: 'https://evil.example', Cookie: cookie })
        .send({});
      expect(foreign.status).toBe(403);
      expectProblem(await refresh(runId, { onOpen: 'yes' }), 422);
      // The worker token grants nothing here.
      const withWorkerToken = await http()
        .post(`/api/runs/${runId}/pull-request/refresh`)
        .set({ Origin: STUDIO_ORIGIN, Authorization: `Bearer ${WORKER_TOKEN}` })
        .send({});
      expect(withWorkerToken.status).toBe(401);
    });
  });

  describe('worker routes', () => {
    it('need the worker token: claim and answer are refused without it, or with the cookie', async () => {
      const runId = await deliveredRun();
      await refresh(runId);

      expect((await claimLookups(W1, null)).status).toBe(401);
      expect((await claimLookups(W1, 'x'.repeat(40))).status).toBe(401);
      const withCookie = await http()
        .post('/api/worker/lookups/claim')
        .set('Cookie', cookie)
        .send({ workerId: W1 });
      expect(withCookie.status).toBe(401);
      const claimed = await claimLookups();
      const id = claimed.body[0].id as string;
      expect((await answer(id, read({ state: 'open' }), null)).status).toBe(401);
      expect((await getRun(runId)).body.pullRequest).toMatchObject({ refreshing: true });
    });

    it('hands out nothing (204) when no lookup waits, and each lookup to one worker', async () => {
      expect((await claimLookups()).status).toBe(204);
      const runId = await deliveredRun();
      await refresh(runId);

      expect((await claimLookups(W1)).status).toBe(200);
      expect((await claimLookups(W2)).status).toBe(204);
    });

    it('hands a claim its worker never answered to another one after the lease of two minutes', async () => {
      const runId = await deliveredRun();
      await refresh(runId);
      expect((await claimLookups(W1)).status).toBe(200);

      advance(119);
      expect((await claimLookups(W2)).status).toBe(204);
      advance(1);
      expect((await claimLookups(W2)).status).toBe(200);
    });

    it('stores each state on the Run, with the branch position and the merge verdict', async () => {
      const runId = await deliveredRun();
      await refresh(runId);
      await readAs({ state: 'draft', behindBy: 2, aheadBy: 3, mergeable: true });

      const run = await getRun(runId);

      expect(run.body.pullRequest).toEqual({
        ...PULL_REQUEST,
        state: 'draft',
        behindBy: 2,
        aheadBy: 3,
        mergeable: true,
        refreshedAt: clock.current.toISOString(),
      });
      // The lists show the state too.
      const listed = (await http().get('/api/runs').set('Cookie', cookie)).body as {
        pullRequest?: { state?: string };
      }[];
      expect(listed[0]?.pullRequest?.state).toBe('draft');
    });

    it('answers 404 for an unknown lookup, 409 for another worker or another kind, 422 for a bad body', async () => {
      const runId = await deliveredRun();
      await refresh(runId);
      const id = (await claimLookups()).body[0].id as string;

      expectProblem(
        await answer(randomUUID(), read({ state: 'open' })),
        404,
        PROBLEM.lookupNotFound,
      );
      expectProblem(await answer('nope', read({ state: 'open' })), 404, PROBLEM.lookupNotFound);
      expectProblem(await answer(id, read({ state: 'open' }, W2)), 409, PROBLEM.lookupNotHeld);
      expectProblem(await answer(id, { ...read({ state: 'open' }), kind: 'checks' }), 422);
      expectProblem(await answer(id, read({ state: 'ready' })), 422);
      expect((await answer(id, read({ state: 'open' }))).status).toBe(204);
      // A repeated answer changes nothing.
      expect((await answer(id, read({ state: 'merged' }))).status).toBe(204);
      expect((await getRun(runId)).body.pullRequest.state).toBe('open');
    });
  });

  describe('failures and rate limits', () => {
    it('keeps the last known state when a lookup fails, and says why', async () => {
      const runId = await deliveredRun();
      await refresh(runId);
      await readAs({ state: 'open', behindBy: 1, aheadBy: 1 });
      await refresh(runId);
      const id = (await claimLookups()).body[0].id as string;

      const failed = await answer(id, {
        workerId: W1,
        ok: false,
        code: 'failed',
        error: 'GitHub could not be reached.',
      });

      expect(failed.status).toBe(204);
      const run = await getRun(runId);
      expect(run.body.pullRequest).toMatchObject({
        state: 'open',
        behindBy: 1,
        refreshError: 'GitHub could not be reached.',
      });
      expect(run.body.pullRequest).not.toHaveProperty('refreshing');
      // Not retried by itself: nothing waits.
      expect((await claimLookups()).status).toBe(204);
      // The next refresh clears the error.
      await refresh(runId);
      await readAs({ state: 'open' });
      expect((await getRun(runId)).body.pullRequest).not.toHaveProperty('refreshError');
    });

    it('retries a rate-limited lookup later, and the Run says when', async () => {
      const runId = await deliveredRun();
      await refresh(runId);
      const id = (await claimLookups()).body[0].id as string;

      const limited = await answer(id, {
        workerId: W1,
        ok: false,
        code: 'rate_limited',
        error: 'GitHub asked to wait.',
        retryAfterSeconds: 300,
      });

      expect(limited.status).toBe(204);
      const retryAt = new Date(clock.current.getTime() + 300_000).toISOString();
      expect((await getRun(runId)).body.pullRequest).toMatchObject({
        refreshError: 'GitHub asked to wait.',
        retryAt,
        refreshing: true,
      });
      advance(299);
      expect((await claimLookups(W2)).status).toBe(204);
      advance(1);
      const again = await claimLookups(W2);
      expect(again.status).toBe(200);
      expect(again.body[0].id).toBe(id);
      expect((await answer(id, read({ state: 'open' }, W2))).status).toBe(204);
      expect((await getRun(runId)).body.pullRequest).not.toHaveProperty('retryAt');
    });

    it('never fails the Run, whatever the lookup does', async () => {
      const runId = await deliveredRun();
      await refresh(runId);
      const id = (await claimLookups()).body[0].id as string;
      await answer(id, {
        workerId: W1,
        ok: false,
        code: 'scope_mismatch',
        error: 'Not the pull request of this run.',
      });

      expect((await getRun(runId)).body).toMatchObject({
        state: 'succeeded',
        delivery: 'delivered',
      });
    });
  });

  describe('Follow-up eligibility by pull request state', () => {
    it('allows a Follow-up while the state is unknown, draft or open', async () => {
      const runId = await deliveredRun();
      expect((await getRun(runId)).body.followUp).toEqual({ allowed: true });
      await refresh(runId);
      await readAs({ state: 'draft' });
      expect((await getRun(runId)).body.followUp).toEqual({ allowed: true });
    });

    it.each([
      ['merged', 'pull_request_merged'],
      ['closed', 'pull_request_closed'],
      ['missing', 'pull_request_missing'],
    ])('refuses a Follow-up when the pull request is %s', async (state, reason) => {
      const runId = await deliveredRun();
      await refresh(runId);
      await readAs({ state });

      expect((await getRun(runId)).body.followUp).toEqual({ allowed: false, reason });
      const refused = await followUp(runId);
      expectProblem(refused, 409, PROBLEM.followUpNotAllowed);
      expect((await getRun(runId)).body.state).toBe('succeeded');
    });

    it('makes the Run eligible again once the next refresh finds the pull request reopened', async () => {
      const runId = await deliveredRun();
      await refresh(runId);
      await readAs({ state: 'closed' });
      expectProblem(await followUp(runId), 409, PROBLEM.followUpNotAllowed);

      await refresh(runId);
      await readAs({ state: 'open', behindBy: 0, aheadBy: 1 });

      expect((await getRun(runId)).body.followUp).toEqual({ allowed: true });
      expect((await followUp(runId)).status).toBe(202);
    });

    it('asks for a refresh when it accepts a Follow-up', async () => {
      const runId = await deliveredRun();

      expect((await followUp(runId)).status).toBe(202);

      const claimed = await claimLookups();
      expect(claimed.status).toBe(200);
      expect(claimed.body[0]).toMatchObject({ runId, pullRequestNumber: 7 });
    });
  });

  describe('the daily refresh', () => {
    const tick = () => dailyPass();
    const openLookups = async () => {
      const rows = await db().$queryRaw<{ run_id: string }[]>`
        SELECT run_id FROM run_lookups WHERE status IN ('requested', 'claimed')`;
      return rows.map((row) => row.run_id);
    };
    /** The Run's pull request was read as `state` more than a day ago. */
    const readLongAgo = async (runId: string, state: string | null) => {
      const readAt = state === null ? null : new Date(clock.current.getTime() - 25 * 3_600_000);
      await db().$executeRaw`
        UPDATE runs SET pr_state = ${state}, pr_refreshed_at = ${readAt}::timestamptz
        WHERE id = ${runId}::uuid`;
    };

    it('asks only about Runs with an open or unknown pull request that was read over a day ago', async () => {
      const unknown = await deliveredRun();
      const open = await deliveredRun();
      await readLongAgo(open, 'open');
      const draft = await deliveredRun();
      await readLongAgo(draft, 'draft');
      const merged = await deliveredRun();
      await readLongAgo(merged, 'merged');
      const closed = await deliveredRun();
      await readLongAgo(closed, 'closed');
      const missing = await deliveredRun();
      await readLongAgo(missing, 'missing');
      const fresh = await deliveredRun();
      await db().$executeRaw`
        UPDATE runs SET pr_state = 'open', pr_refreshed_at = ${clock.current}::timestamptz
        WHERE id = ${fresh}::uuid`;
      const noPullRequest = await deliveredRun({ delivered: false });

      await tick();

      const asked = await openLookups();
      expect(new Set(asked)).toEqual(new Set([unknown, open, draft]));
      expect(asked).not.toContain(noPullRequest);
      // Ask again: still one lookup per Run.
      await tick();
      expect(await openLookups()).toHaveLength(3);
    });

    it('asks a Run whose lookups keep failing once a day, and removes lookups finished over a week ago', async () => {
      const failing = await deliveredRun();
      await refresh(failing);
      const id = (await claimLookups()).body[0].id as string;
      await answer(id, {
        workerId: W1,
        ok: false,
        code: 'failed',
        error: 'GitHub could not be reached.',
      });

      await tick();
      expect(await openLookups()).toEqual([]);

      advance(25 * 3600);
      await tick();
      expect(await openLookups()).toEqual([failing]);

      advance(8 * 24 * 3600);
      await tick();
      const finished = await db().$queryRaw<{ count: bigint }[]>`
        SELECT count(*) FROM run_lookups WHERE status IN ('done', 'failed')`;
      expect(Number(finished[0]!.count)).toBe(0);
    });

    it('lets a worker carry the requests out with reads only, and starts no Run', async () => {
      const runId = await deliveredRun();
      await tick();

      const claimed = await claimLookups();
      expect(claimed.status).toBe(200);
      expect(claimed.body).toHaveLength(1);
      expect(await answer(claimed.body[0].id, read({ state: 'merged' }))).toMatchObject({
        status: 204,
      });
      const run = await getRun(runId);
      expect(run.body).toMatchObject({ state: 'succeeded', pullRequest: { state: 'merged' } });
      // Nothing was queued for an agent: no Run waits to be claimed.
      expect((await asWorker('runs/claim', { workerId: W1 })).status).toBe(204);
    });
  });
});
