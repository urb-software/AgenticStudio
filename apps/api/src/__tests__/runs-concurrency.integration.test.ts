import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// Issue #167 (Epic #160), concurrency evidence: the operator-triggered operations on a Run
// (answer, Follow-up, cancel, delivery retry, resume after the usage limit) against themselves and
// against what the agent worker reports. Each case loops ITERATIONS times with real concurrency
// (two HTTP requests started together on separate database connections) and checks the outcome
// that may never differ: exactly one winner where the operation is not repeatable, one consistent
// final Run, and never a message, a place or a result that the loser could have stored. These
// tests were written against the code before the operations moved into the Run class and pass on
// both; they run in the pull request's CI (the race is the evidence, so a reviewer re-runs them).

const ITERATIONS = 25;
const CASE_TIMEOUT = 180_000;

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
const USAGE_LIMIT = {
  code: 'usage_limit',
  detail: 'The Claude Code usage limit was reached; it resets at 2026-11-16T17:00:00.000Z.',
};
const PROBLEM = {
  runAlreadyFinished: 'urn:agentic-studio:problem:run-already-finished',
  runNotWaiting: 'urn:agentic-studio:problem:run-not-waiting',
  runNotResumable: 'urn:agentic-studio:problem:run-not-resumable',
  resumeSlotTaken: 'urn:agentic-studio:problem:resume-slot-taken',
  followUpNotAllowed: 'urn:agentic-studio:problem:follow-up-not-allowed',
  runNotHeld: 'urn:agentic-studio:problem:run-not-held',
};

interface MessageView {
  kind: string;
  text?: string;
}

describe('operator operations racing each other and the agent worker (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  let cookie: string;
  const clock = { current: new Date(), now: () => clock.current };
  const W1 = randomUUID();

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const operator = () => ({ Origin: STUDIO_ORIGIN, Cookie: cookie });
  const worker = (path: string, body: object) =>
    http().post(`/api/worker/${path}`).set('Authorization', `Bearer ${WORKER_TOKEN}`).send(body);
  const getRun = (runId: string) => http().get(`/api/runs/${runId}`).set('Cookie', cookie);

  const cancel = (runId: string) => http().post(`/api/runs/${runId}/cancel`).set(operator()).send();
  const answer = (runId: string, text = 'PostgreSQL') =>
    http().post(`/api/runs/${runId}/answer`).set(operator()).send({ text });
  const resume = (runId: string) => http().post(`/api/runs/${runId}/resume`).set(operator()).send();
  const retryDelivery = (runId: string) =>
    http().post(`/api/runs/${runId}/retry-delivery`).set(operator()).send();
  const followUp = (runId: string, body: object = { text: 'Also handle HEAD requests.' }) =>
    http().post(`/api/runs/${runId}/follow-up`).set(operator()).send(body);
  const bringUpToDate = (runId: string) =>
    http().post(`/api/runs/${runId}/bring-up-to-date`).set(operator()).send({});
  const claim = () => worker('runs/claim', { workerId: W1 });
  const report = (runId: string, body: object) =>
    worker(`runs/${runId}/state`, { workerId: W1, ...body });
  const step = (runId: string, result: object) =>
    worker(`runs/${runId}/steps`, {
      workerId: W1,
      index: 1,
      kind: 'start',
      result,
      workingCopy: WORKING_COPY,
    });

  /** Two requests started together; both are awaited. */
  const race = (a: PromiseLike<request.Response>, b: PromiseLike<request.Response>) =>
    Promise.all([a, b]);
  const statuses = (...responses: request.Response[]) =>
    responses.map((response) => response.status).sort((a, b) => a - b);
  const count = (list: MessageView[], kind: string) =>
    list.filter((message) => message.kind === kind).length;

  /** Test isolation for one iteration: no Run of an earlier one holds a place or is claimable. */
  async function freshIteration() {
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    await db().$executeRaw`TRUNCATE TABLE run_lease_renewals`;
    clock.current = new Date();
    const status = await worker('status', {
      workerId: W1,
      runner: 'cli',
      providers: { claude_code: true, codex: true },
    });
    expect(status.status).toBe(204);
  }

  async function newProject() {
    const name = `Shop ${randomUUID()}`;
    const [project] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    const url = `https://git.example.test/acme/${project!.id}.git`;
    await db().$executeRaw`
      INSERT INTO repositories
        (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
      VALUES (${project!.id}::uuid, ${url}, ${url.slice(8, -4)}, 'dev', 'ready',
              ${randomBytes(20).toString('hex')}, now())`;
    return project!.id;
  }

  async function queuedRun(projectId: string) {
    const started = await http()
      .post(`/api/projects/${projectId}/runs`)
      .set(operator())
      .send({ task: 'Add a health check', provider: 'claude_code' });
    expect(started.status).toBe(201);
    return started.body.id as string;
  }

  /** A Run of a new project, claimed by W1 and `running`. */
  async function runningRun(projectId?: string) {
    const runId = await queuedRun(projectId ?? (await newProject()));
    expect((await claim()).status).toBe(200);
    expect((await report(runId, { state: 'running' })).status).toBe(204);
    return runId;
  }

  /** The agent asked a question and the Run waits for the operator. */
  async function waitingRun() {
    const runId = await runningRun();
    const asked = await step(runId, {
      outcome: 'needs_input',
      summary: 'A decision is needed.',
      question: { text: 'Which database?', options: ['PostgreSQL', 'SQLite'] },
      sessionRef: 'session-1',
    });
    expect(asked.status).toBe(204);
    expect((await report(runId, { state: 'waiting_for_operator' })).status).toBe(204);
    return runId;
  }

  /** The delivery failed after one done step. */
  async function failedDeliveryRun() {
    const runId = await runningRun();
    expect((await step(runId, { outcome: 'done', summary: 'Done.' })).status).toBe(204);
    const failed = await report(runId, {
      state: 'failed',
      failure: { code: 'delivery_failed', detail: 'Pushing the Run branch was refused.' },
    });
    expect(failed.status).toBe(204);
    return runId;
  }

  /** The first step stopped at the usage limit. */
  async function limitedRun(projectId?: string) {
    const runId = await queuedRun(projectId ?? (await newProject()));
    expect((await claim()).status).toBe(200);
    await report(runId, { state: 'running' });
    const failed = await report(runId, {
      state: 'failed',
      failure: USAGE_LIMIT,
      workingCopy: WORKING_COPY,
      sessionRef: 'session-9',
    });
    expect(failed.status).toBe(204);
    return runId;
  }

  /** Delivered with its pull request after one done step (open to a Follow-up). */
  async function deliveredRun() {
    const runId = await runningRun();
    const stepped = await step(runId, {
      outcome: 'done',
      summary: 'Added GET /health.',
      sessionRef: 'session-7',
    });
    expect(stepped.status).toBe(204);
    const ended = await report(runId, {
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

  describe('answering a question', () => {
    it(
      'stores one answer when two answers arrive together',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await waitingRun();

          const responses = await race(answer(runId, 'first'), answer(runId, 'second'));

          expect(statuses(...responses)).toEqual([202, 409]);
          const refused = responses.find((response) => response.status === 409)!;
          expect(refused.body.type).toBe(PROBLEM.runNotWaiting);
          const run = (await getRun(runId)).body;
          expect(run.state).toBe('queued');
          expect(count(run.messages, 'answer')).toBe(1);
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'either answers or is cancelled by the long-wait sweep that runs with a claim, never both',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await waitingRun();
          // The Run has now waited longer than its waiting period: the next claim cancels it.
          clock.current = new Date(clock.current.getTime() + 15 * 24 * 60 * 60 * 1000);

          const [answered, claimed] = await race(answer(runId), claim());

          const run = (await getRun(runId)).body;
          if (answered.status === 202) {
            expect(run.state).not.toBe('cancelled');
            expect(run).not.toHaveProperty('cancellation');
            expect(count(run.messages, 'answer')).toBe(1);
          } else {
            expect(answered.status).toBe(409);
            expect(answered.body.type).toBe(PROBLEM.runNotWaiting);
            expect(run.state).toBe('cancelled');
            expect(run.cancellation.by).toBe('system');
            expect(count(run.messages, 'answer')).toBe(0);
            expect(claimed.status).toBe(204);
          }
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'either answers or is cancelled by the operator, never both',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await waitingRun();

          const [answered, cancelled] = await race(answer(runId), cancel(runId));

          const run = (await getRun(runId)).body;
          if (answered.status === 202) {
            // The answer won: the Run was queued again; the cancel then cancelled that queued Run
            // (or was told it had finished).
            expect(count(run.messages, 'answer')).toBe(1);
            expect([202, 409]).toContain(cancelled.status);
          } else {
            expect(answered.status).toBe(409);
            expect(cancelled.status).toBe(202);
            expect(run.state).toBe('cancelled');
            expect(count(run.messages, 'answer')).toBe(0);
          }
        }
      },
      CASE_TIMEOUT,
    );
  });

  describe('cancelling', () => {
    it(
      'cancels a queued Run once when two cancels arrive together',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await queuedRun(await newProject());

          const responses = await race(cancel(runId), cancel(runId));

          expect(statuses(...responses)).toEqual([202, 409]);
          const refused = responses.find((response) => response.status === 409)!;
          expect(refused.body.type).toBe(PROBLEM.runAlreadyFinished);
          const run = (await getRun(runId)).body;
          expect(run.state).toBe('cancelled');
          expect(run.cancellation).toEqual({
            by: 'operator',
            reason: 'Cancelled by the operator.',
          });
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'records one cancel request on a running Run when two cancels arrive together',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await runningRun();

          const responses = await race(cancel(runId), cancel(runId));

          expect(statuses(...responses)).toEqual([202, 202]);
          const first = responses[0].body.cancelRequestedAt;
          expect(first).toEqual(expect.any(String));
          expect(responses[1].body.cancelRequestedAt).toBe(first);
          const run = (await getRun(runId)).body;
          expect(run.state).toBe('running');
          expect(run.cancelRequestedAt).toBe(first);
          const beat = await worker(`runs/${runId}/heartbeat`, { workerId: W1 });
          expect(beat.body).toEqual({ cancelRequested: true });
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'ends a cancelled Run when the worker reports it waiting at the same moment',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await runningRun();

          const [cancelled, reported] = await race(
            cancel(runId),
            report(runId, { state: 'waiting_for_operator' }),
          );

          expect(cancelled.status).toBe(202);
          expect(reported.status).toBe(204);
          const run = (await getRun(runId)).body;
          expect(run.state).toBe('cancelled');
          expect(run.cancellation.by).toBe('operator');
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'keeps the worker report that finished the Run when the cancel comes at the same moment',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await runningRun();
          expect((await step(runId, { outcome: 'done', summary: 'Done.' })).status).toBe(204);

          const [cancelled, reported] = await race(
            cancel(runId),
            report(runId, { state: 'succeeded', delivery: { outcome: 'none' } }),
          );

          expect(reported.status).toBe(204);
          expect([202, 409]).toContain(cancelled.status);
          if (cancelled.status === 409) {
            expect(cancelled.body.type).toBe(PROBLEM.runAlreadyFinished);
          }
          const run = (await getRun(runId)).body;
          expect(run.state).toBe('succeeded');
        }
      },
      CASE_TIMEOUT,
    );
  });

  describe('requesting a delivery retry', () => {
    it(
      'requests the retry once when two requests arrive together, and hands out one delivery',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await failedDeliveryRun();

          const responses = await race(retryDelivery(runId), retryDelivery(runId));

          expect(statuses(...responses)).toEqual([202, 202]);
          const run = (await getRun(runId)).body;
          expect(run).toMatchObject({ state: 'failed', deliveryRetryRequested: true });
          const claimed = await claim();
          expect(claimed.status).toBe(200);
          expect(claimed.body).toMatchObject({ runId, kind: 'deliver' });
          expect((await claim()).status).toBe(204);
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'is either seen by the worker claim that runs at the same moment or by the next one',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await failedDeliveryRun();

          const [requested, claimed] = await race(retryDelivery(runId), claim());

          expect(requested.status).toBe(202);
          if (claimed.status === 200) {
            expect(claimed.body).toMatchObject({ runId, kind: 'deliver' });
            expect((await claim()).status).toBe(204);
          } else {
            expect(claimed.status).toBe(204);
            const later = await claim();
            expect(later.status).toBe(200);
            expect(later.body).toMatchObject({ runId, kind: 'deliver' });
          }
          expect((await getRun(runId)).body).toMatchObject({
            state: 'failed',
            deliveryRetryRequested: true,
          });
        }
      },
      CASE_TIMEOUT,
    );
  });

  describe('resuming after the usage limit', () => {
    it(
      'resumes once when two requests arrive together',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await limitedRun();

          const responses = await race(resume(runId), resume(runId));

          expect(statuses(...responses)).toEqual([202, 409]);
          const refused = responses.find((response) => response.status === 409)!;
          expect(refused.body.type).toBe(PROBLEM.runNotResumable);
          const run = (await getRun(runId)).body;
          expect(run.state).toBe('queued');
          expect(count(run.messages, 'answer')).toBe(1);
        }
      },
      CASE_TIMEOUT,
    );

    it(
      "never holds the project's place twice when a claim of another Run comes at the same moment",
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const projectId = await newProject();
          const limited = await limitedRun(projectId);
          // The project is free again: a second Run waits in its queue.
          const other = await queuedRun(projectId);

          const [resumed, claimed] = await race(resume(limited), claim());

          expect(claimed.status).toBe(200);
          if (resumed.status === 202) {
            // Resumed first: the resumed Run keeps the project's place, so the claim got it.
            expect(claimed.body).toMatchObject({ runId: limited, kind: 'resume' });
            expect((await getRun(other)).body.state).toBe('queued');
          } else {
            // The other Run was claimed first: the resume is refused clearly, nothing changed.
            expect(resumed.status).toBe(409);
            expect(resumed.body.type).toBe(PROBLEM.resumeSlotTaken);
            expect(claimed.body.runId).toBe(other);
            const stopped = (await getRun(limited)).body;
            expect(stopped.state).toBe('failed');
            expect(count(stopped.messages, 'answer')).toBe(0);
          }
          const places = await db().$queryRaw<{ active: number }[]>`
            SELECT count(*)::int AS active FROM runs
            WHERE state IN ('preparing', 'running', 'waiting_for_operator')
               OR (state = 'queued' AND session_ref IS NOT NULL)`;
          expect(places[0]!.active).toBe(1);
        }
      },
      CASE_TIMEOUT,
    );
  });

  describe('sending a Follow-up', () => {
    it(
      'stores one Follow-up when two arrive together',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await deliveredRun();

          const responses = await race(
            followUp(runId, { text: 'First.' }),
            followUp(runId, { text: 'Second.' }),
          );

          expect(statuses(...responses)).toEqual([202, 409]);
          const refused = responses.find((response) => response.status === 409)!;
          expect(refused.body.type).toBe(PROBLEM.followUpNotAllowed);
          const run = (await getRun(runId)).body;
          expect(run).toMatchObject({ state: 'queued', followUps: 1 });
          expect(count(run.messages, 'follow_up')).toBe(1);
          expect(count(run.messages, 'part_end')).toBe(1);
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'queues one request to bring the branch up to date when two arrive together',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await deliveredRun();

          const responses = await race(bringUpToDate(runId), bringUpToDate(runId));

          expect(statuses(...responses)).toEqual([202, 409]);
          const run = (await getRun(runId)).body;
          expect(run).toMatchObject({ state: 'queued', followUps: 1 });
          expect(count(run.messages, 'follow_up')).toBe(1);
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'is a Follow-up or a refusal, consistent with the removal of the Working copy the worker reports at the same moment',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await deliveredRun();

          const [sent, removed] = await race(
            followUp(runId),
            worker('runs/states', { workerId: W1, runIds: [runId], removedRunIds: [runId] }),
          );

          expect(removed.status).toBe(200);
          const run = (await getRun(runId)).body;
          if (sent.status === 202) {
            expect(run.followUps).toBe(1);
            expect(count(run.messages, 'follow_up')).toBe(1);
          } else {
            expect(sent.status).toBe(409);
            expect(sent.body.type).toBe(PROBLEM.followUpNotAllowed);
            expect(run.followUps).toBe(0);
            expect(count(run.messages, 'follow_up')).toBe(0);
            expect(run.state).toBe('succeeded');
          }
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'sends only Review comments that are in the loaded set when a new load completes at the same moment',
      async () => {
        const read = (comments: object[]) => ({
          workerId: W1,
          ok: true,
          kind: 'review_comments',
          result: { comments, truncated: false },
        });
        const comment = (id: string) => ({
          id,
          author: 'octocat',
          kind: 'conversation',
          text: `Comment ${id}`,
          createdAt: new Date(Date.UTC(2099, 0, 1, 10, 1)).toISOString(),
        });
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const runId = await deliveredRun();
          const loadComments = async () => {
            const asked = await http()
              .post(`/api/runs/${runId}/pull-request/review-comments/load`)
              .set(operator())
              .send({ scope: 'unresolved' });
            expect(asked.status).toBe(202);
            const lookups = await worker('lookups/claim', { workerId: W1 });
            expect(lookups.status).toBe(200);
            return lookups.body[0].id as string;
          };
          const firstLookup = await loadComments();
          expect(
            (await worker(`lookups/${firstLookup}/result`, read([comment('conversation-1')])))
              .status,
          ).toBe(204);
          const secondLookup = await loadComments();

          const [sent, completed] = await race(
            followUp(runId, {
              text: 'Please fix these.',
              source: 'review_comments',
              reviewCommentIds: ['conversation-1'],
            }),
            worker(`lookups/${secondLookup}/result`, read([comment('conversation-2')])),
          );

          expect(completed.status).toBeLessThan(500);
          const run = (await getRun(runId)).body;
          if (sent.status === 202) {
            // The comment was in the set when the Follow-up locked the Run.
            expect(run.followUps).toBe(1);
            expect(count(run.messages, 'follow_up')).toBe(1);
          } else {
            // The new load replaced the set first: the selected comment is not in it any more.
            expect(sent.status).toBe(422);
            expect(run.followUps).toBe(0);
            expect(count(run.messages, 'follow_up')).toBe(0);
          }
        }
      },
      CASE_TIMEOUT,
    );
  });

  // Issue #169 (Epic #160): what the agent worker triggers on a Run, against itself, against the
  // operator and against the sweeps. Written first against the code before the worker-triggered
  // operations moved into the Run class; every case here but the one marked `fails` passed on it
  // and keeps passing.
  describe('what the agent worker triggers', () => {
    const W2 = randomUUID();
    const claimAs = (workerId: string) => worker('runs/claim', { workerId });
    const heartbeat = (runId: string) => worker(`runs/${runId}/heartbeat`, { workerId: W1 });
    const claimedBy = async (runId: string) =>
      (
        await db().$queryRaw<{ claimed_by: string | null }[]>`
          SELECT claimed_by FROM runs WHERE id = ${runId}::uuid`
      )[0]!.claimed_by;
    const runIdsOf = (...responses: request.Response[]) =>
      responses
        .filter((response) => response.status === 200)
        .map((response) => response.body.runId as string);
    /** The clock moves past the worker lease: held Runs without a heartbeat are lost. */
    const pastTheLease = () => {
      clock.current = new Date(clock.current.getTime() + (LEASE_SECONDS + 5) * 1000);
    };
    const activePlaces = async () =>
      (
        await db().$queryRaw<{ active: number }[]>`
          SELECT count(*)::int AS active FROM runs
          WHERE state IN ('preparing', 'running', 'waiting_for_operator')`
      )[0]!.active;

    describe('handing out the next Run', () => {
      it(
        'hands one queued Run to only one of two claims arriving together',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const runId = await queuedRun(await newProject());

            const [first, second] = await race(claimAs(W1), claimAs(W2));

            expect(statuses(first, second)).toEqual([200, 204]);
            expect(runIdsOf(first, second)).toEqual([runId]);
            expect(await claimedBy(runId)).toBe(first.status === 200 ? W1 : W2);
            expect((await getRun(runId)).body.state).toBe('preparing');
          }
        },
        CASE_TIMEOUT,
      );

      it(
        'hands out one Run of a project, the oldest, when two claims arrive together',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const projectId = await newProject();
            const older = await queuedRun(projectId);
            const newer = await queuedRun(projectId);

            const [first, second] = await race(claimAs(W1), claimAs(W2));

            expect(statuses(first, second)).toEqual([200, 204]);
            expect(runIdsOf(first, second)).toEqual([older]);
            expect((await getRun(newer)).body.state).toBe('queued');
            expect(await activePlaces()).toBe(1);
          }
        },
        CASE_TIMEOUT,
      );

      it(
        'never hands out more Runs than the server allows when three claims arrive together',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const runIds = [
              await queuedRun(await newProject()),
              await queuedRun(await newProject()),
              await queuedRun(await newProject()),
            ];

            const responses = await Promise.all([claimAs(W1), claimAs(W2), claimAs(randomUUID())]);

            expect(statuses(...responses)).toEqual([200, 200, 204]);
            const handedOut = runIdsOf(...responses);
            expect(new Set(handedOut).size).toBe(2);
            for (const runId of handedOut) expect(runIds).toContain(runId);
            expect(await activePlaces()).toBe(2);
          }
        },
        CASE_TIMEOUT,
      );

      it(
        'hands an answered Run only to the worker that started it',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const runId = await waitingRun();
            expect((await answer(runId)).status).toBe(202);

            const [stranger, owner] = await race(claimAs(W2), claimAs(W1));

            expect(stranger.status).toBe(204);
            expect(owner.status).toBe(200);
            expect(owner.body).toMatchObject({ runId, kind: 'resume' });
            expect(await claimedBy(runId)).toBe(W1);
          }
        },
        CASE_TIMEOUT,
      );
    });

    // A cancel of a queued Run that lands after the claim read the Run and before it updated it.
    // The test holds the Run's row (as the cancel's own transaction does), starts the claim, and
    // commits the cancel once the claim is done or waits for the row. Only the claim of dev's
    // code can fail here, with a database "not found" (Issue #167's review; Epic #160).
    describe('a claim and a cancel of the Run it would hand out', () => {
      it.fails(
        'gets the next eligible Run or nothing, never an error, when the cancel lands in between',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const runId = await queuedRun(await newProject());
            let claimed!: Promise<request.Response>;

            await db().$transaction(
              async (tx) => {
                await tx.$queryRaw`SELECT id FROM runs WHERE id = ${runId}::uuid FOR UPDATE`;
                let settled = false;
                claimed = Promise.resolve(claim()).finally(() => {
                  settled = true;
                });
                for (let waited = 0; waited < 3000 && !settled; waited += 50) {
                  const [waiting] = await tx.$queryRaw<{ n: number }[]>`
                    SELECT count(*)::int AS n FROM pg_stat_activity
                    WHERE datname = current_database() AND wait_event_type = 'Lock'
                      AND pid <> pg_backend_pid()`;
                  if (waiting!.n > 0) break;
                  await new Promise((resolve) => setTimeout(resolve, 50));
                }
                await tx.$executeRaw`
                  UPDATE runs SET state = 'cancelled', cancelled_by = 'operator',
                    cancel_reason = 'Cancelled by the operator.', finished_at = now()
                  WHERE id = ${runId}::uuid`;
              },
              { timeout: 30_000, maxWait: 10_000 },
            );

            const response = await claimed;
            expect(response.status).toBe(204);
            expect((await getRun(runId)).body.state).toBe('cancelled');
          }
        },
        CASE_TIMEOUT,
      );
    });

    describe('a report of the worker and what else changes the Run', () => {
      it(
        'keeps the Answer when the worker repeats its waiting report at the same moment',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const runId = await waitingRun();

            const [answered, repeated] = await race(
              answer(runId),
              report(runId, { state: 'waiting_for_operator' }),
            );

            expect(answered.status).toBe(202);
            // Before the Answer the repeat changes nothing; after it, the worker no longer
            // holds the Run (nobody does: it is queued again).
            expect([204, 409]).toContain(repeated.status);
            if (repeated.status === 409) expect(repeated.body.type).toBe(PROBLEM.runNotHeld);
            const run = (await getRun(runId)).body;
            expect(run.state).toBe('queued');
            expect(count(run.messages, 'answer')).toBe(1);
          }
        },
        CASE_TIMEOUT,
      );

      it(
        'keeps the Follow-up when the worker repeats its succeeded report at the same moment',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const runId = await deliveredRun();

            const [sent, repeated] = await race(
              followUp(runId),
              report(runId, {
                state: 'succeeded',
                delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
              }),
            );

            expect(sent.status).toBe(202);
            expect([204, 409]).toContain(repeated.status);
            if (repeated.status === 409) expect(repeated.body.type).toBe(PROBLEM.runNotHeld);
            const run = (await getRun(runId)).body;
            expect(run).toMatchObject({ state: 'queued', followUps: 1 });
            expect(count(run.messages, 'follow_up')).toBe(1);
          }
        },
        CASE_TIMEOUT,
      );
    });

    describe('a worker that lost its claim', () => {
      it(
        'is refused a late report, Run step and heartbeat, and the Run stays failed',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const runId = await runningRun();
            pastTheLease();
            // The sweep that runs before every claim fails the Run.
            expect((await claim()).status).toBe(204);

            const late = await report(runId, {
              state: 'succeeded',
              delivery: { outcome: 'none' },
            });
            const lateStep = await step(runId, { outcome: 'done', summary: 'Done.' });
            const lateBeat = await heartbeat(runId);

            for (const refused of [late, lateStep, lateBeat]) {
              expect(refused.status).toBe(409);
              expect(refused.body.type).toBe(PROBLEM.runNotHeld);
            }
            const run = (await getRun(runId)).body;
            expect(run.state).toBe('failed');
            expect(run.failure.code).toBe('worker_lost');
            const [steps] = await db().$queryRaw<{ n: number }[]>`
              SELECT count(*)::int AS n FROM run_steps WHERE run_id = ${runId}::uuid`;
            expect(steps!.n).toBe(0);
          }
        },
        CASE_TIMEOUT,
      );

      it(
        'is either finished by its report or failed as lost by the sweep that runs at the same moment, never both',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const runId = await runningRun();
            expect((await step(runId, { outcome: 'done', summary: 'Done.' })).status).toBe(204);
            pastTheLease();

            const [reported] = await race(
              report(runId, { state: 'succeeded', delivery: { outcome: 'none' } }),
              claim(),
            );

            const run = (await getRun(runId)).body;
            if (reported.status === 204) {
              expect(run.state).toBe('succeeded');
              expect(run).not.toHaveProperty('failure');
            } else {
              expect(reported.status).toBe(409);
              expect(reported.body.type).toBe(PROBLEM.runNotHeld);
              expect(run.state).toBe('failed');
              expect(run.failure.code).toBe('worker_lost');
            }
          }
        },
        CASE_TIMEOUT,
      );
    });

    describe('a heartbeat', () => {
      it(
        'either keeps the Run or finds it failed as lost when the sweep runs at the same moment',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const runId = await runningRun();
            pastTheLease();

            const [beat] = await race(heartbeat(runId), claim());

            const run = (await getRun(runId)).body;
            if (beat.status === 200) {
              expect(beat.body).toEqual({ cancelRequested: false });
              expect(run.state).toBe('running');
            } else {
              expect(beat.status).toBe(409);
              expect(beat.body.type).toBe(PROBLEM.runNotHeld);
              expect(run.state).toBe('failed');
              expect(run.failure.code).toBe('worker_lost');
            }
          }
        },
        CASE_TIMEOUT,
      );
    });

    describe('the outcome of a delivery retry', () => {
      /** The delivery failed, a retry was requested and the worker holds the Run for it. */
      async function retryingRun() {
        const runId = await failedDeliveryRun();
        expect((await retryDelivery(runId)).status).toBe(202);
        const claimed = await claim();
        expect(claimed.status).toBe(200);
        expect(claimed.body).toMatchObject({ runId, kind: 'deliver' });
        return runId;
      }

      it(
        'finishes the Run when the operator asks for the retry again at the same moment',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const runId = await retryingRun();

            const [requested, reported] = await race(
              retryDelivery(runId),
              report(runId, {
                state: 'succeeded',
                delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
              }),
            );

            expect(reported.status).toBe(204);
            // Asked again while the retry is under way, nothing changes; asked after it, the
            // Run has no failed delivery any more.
            expect([202, 409]).toContain(requested.status);
            const run = (await getRun(runId)).body;
            expect(run.state).toBe('succeeded');
            expect(run.deliveryRetryRequested).not.toBe(true);
            expect((await claim()).status).toBe(204);
          }
        },
        CASE_TIMEOUT,
      );

      it(
        'leaves exactly one pending retry or none when the retry fails again at the same moment',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const runId = await retryingRun();

            const [requested, reported] = await race(
              retryDelivery(runId),
              report(runId, {
                state: 'failed',
                failure: { code: 'delivery_failed', detail: 'Pushing was refused again.' },
              }),
            );

            expect(reported.status).toBe(204);
            expect(requested.status).toBe(202);
            const run = (await getRun(runId)).body;
            expect(run.state).toBe('failed');
            // Asked before the outcome: the outcome ends the request. Asked after: it is a new one.
            const next = await claim();
            if (run.deliveryRetryRequested === true) {
              expect(next.status).toBe(200);
              expect(next.body).toMatchObject({ runId, kind: 'deliver' });
              expect((await claim()).status).toBe(204);
            } else {
              expect(next.status).toBe(204);
            }
          }
        },
        CASE_TIMEOUT,
      );
    });
  });
});
