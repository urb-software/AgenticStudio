import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRunLogRepository } from '../../../domain/repositories/__tests__/in-memory-run-log-repository.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { ClaimRunHandler } from '../handler.js';

// Issue #96: handing out work under the concurrency limits, after the lost-worker sweep.
const [A, B, C] = [
  '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
  '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f',
  '5b4d0e3a-6f7c-4d8e-9fa0-1b2c3d4e5f6a',
] as const;
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const T0 = new Date('2026-11-15T12:00:00.000Z');

describe('ClaimRunHandler', () => {
  let runs: InMemoryRunRepository;
  let logs: InMemoryRunLogRepository;
  let now: Date;
  let handler: ClaimRunHandler;

  const queue = (projectId: string) =>
    runs.add({
      projectId,
      provider: 'claude_code',
      task: `Task of ${projectId}`,
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14 },
      integrationBranch: 'dev',
    });

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    logs = new InMemoryRunLogRepository(runs);
    now = T0;
    handler = new ClaimRunHandler(runs, logs, { now: () => now }, { seconds: 60 });
  });

  it('hands out nothing when no Run is queued', async () => {
    expect(await handler.execute(WORKER)).toBeNull();
  });

  it('hands out the oldest queued Run as preparing, held by the worker', async () => {
    const first = await queue(A);
    await queue(B);

    const claimed = await handler.execute(WORKER);

    expect(claimed).toMatchObject({
      id: first.id,
      state: 'preparing',
      claimedBy: WORKER,
      startedAt: T0,
    });
  });

  it('keeps one active Run per project and two across the server; the rest wait in order', async () => {
    const a1 = await queue(A);
    const a2 = await queue(A);
    const b1 = await queue(B);
    const c1 = await queue(C);

    expect((await handler.execute(WORKER))?.id).toBe(a1.id);
    expect((await handler.execute(OTHER_WORKER))?.id).toBe(b1.id);
    expect(await handler.execute(WORKER)).toBeNull();

    expect((await runs.findById(a2.id))?.state).toBe('queued');
    expect((await runs.findById(c1.id))?.state).toBe('queued');
  });

  it('fails a Run without a remote URL as preparation_failed and hands out the next (review of #117)', async () => {
    const orphan = await runs.add({
      projectId: A,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: '',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14 },
      integrationBranch: '',
    });
    const next = await queue(B);

    const claimed = await handler.execute(WORKER);

    expect(claimed?.id).toBe(next.id);
    expect(await runs.findById(orphan.id)).toMatchObject({
      state: 'failed',
      failure: { code: 'preparation_failed' },
      claimedBy: null,
    });
  });

  describe('delivery retries (Issue #102)', () => {
    const WORKING_COPY = {
      runBranch: 'agent/x-r0b8e5c2d',
      commits: [],
      hasUncommittedChanges: false,
    };

    /** A Run of `projectId` that WORKER started and whose delivery failed, released. */
    async function failedDelivery(projectId: string, recorded = true) {
      const run = await queue(projectId);
      await runs.claimNext(WORKER, T0);
      for (const [from, to] of [
        ['preparing', 'running'],
        ['running', 'failed'],
      ] as const) {
        await runs.transitionClaimed({
          runId: run.id,
          workerId: WORKER,
          from,
          to,
          failure: to === 'failed' ? { code: 'delivery_failed', detail: 'refused' } : null,
          workingCopy: to === 'failed' && recorded ? WORKING_COPY : null,
          cancelRequested: false,
          now: T0,
        });
      }
      return run;
    }

    it('hands out a requested delivery retry, still failed, held by the worker', async () => {
      const run = await failedDelivery(A);
      await runs.requestDeliveryRetry(run.id);

      expect(await handler.execute(WORKER)).toMatchObject({
        id: run.id,
        state: 'failed',
        deliveryRequested: true,
        claimedBy: WORKER,
      });
      // Held: handed out once.
      expect(await handler.execute(WORKER)).toBeNull();
    });

    it('hands a retry only to the worker that started the Run, which has its Working copy (review R4)', async () => {
      const run = await failedDelivery(A);
      await runs.requestDeliveryRetry(run.id);

      expect(await handler.execute(OTHER_WORKER)).toBeNull();
      expect((await handler.execute(WORKER))?.id).toBe(run.id);
    });

    it('hands out no failed delivery whose retry was not requested', async () => {
      await failedDelivery(A);

      expect(await handler.execute(WORKER)).toBeNull();
    });

    it('fails and releases at once a retry with no recorded Run branch (review R5)', async () => {
      const run = await failedDelivery(A, false);
      await runs.requestDeliveryRetry(run.id);

      expect(await handler.execute(WORKER)).toBeNull();
      expect(await runs.findById(run.id)).toMatchObject({
        state: 'failed',
        failure: {
          code: 'delivery_failed',
          detail: expect.stringContaining('cannot be delivered'),
        },
        deliveryRequested: false,
        claimedBy: null,
      });
    });

    it('counts a held delivery retry toward the limits', async () => {
      const retry = await failedDelivery(A);
      await runs.requestDeliveryRetry(retry.id);
      await handler.execute(WORKER);
      const a2 = await queue(A);
      const b1 = await queue(B);
      const c1 = await queue(C);

      expect((await handler.execute(OTHER_WORKER))?.id).toBe(b1.id);
      expect(await handler.execute(OTHER_WORKER)).toBeNull();
      expect((await runs.findById(a2.id))?.state).toBe('queued');
      expect((await runs.findById(c1.id))?.state).toBe('queued');
    });

    it('keeps a retry whose worker was lost a failed delivery, so it can be retried again', async () => {
      const run = await failedDelivery(A);
      await runs.requestDeliveryRetry(run.id);
      await handler.execute(WORKER);
      now = new Date(T0.getTime() + 61_000);

      await handler.execute(OTHER_WORKER);

      expect(await runs.findById(run.id)).toMatchObject({
        state: 'failed',
        failure: {
          code: 'delivery_failed',
          detail: expect.stringContaining('retried the delivery'),
        },
        delivery: 'failed',
        deliveryRequested: false,
        claimedBy: null,
      });
    });
  });

  // Issue #103: an answered Run goes back to the worker that has its Working copy and session.
  describe('resumes (Issue #103)', () => {
    const WORKING_COPY = {
      runBranch: 'agent/x-r0b8e5c2d',
      commits: [],
      hasUncommittedChanges: false,
    };
    const QUESTION = { text: 'Which database?' };

    /** WORKER carries a Run of `projectId` to a question (logging 3 events), then it is answered. */
    async function answered(projectId: string, recorded = true) {
      const run = await queue(projectId);
      await runs.claimNext(WORKER, T0);
      await runs.transitionClaimed({
        runId: run.id,
        workerId: WORKER,
        from: 'preparing',
        to: 'running',
        failure: null,
        cancelRequested: false,
        now: T0,
      });
      await logs.append(
        run.id,
        WORKER,
        [1, 2, 3].map((seq) => ({
          seq,
          at: T0,
          stepIndex: 1,
          kind: 'message' as const,
          text: 'x',
          truncated: false,
        })),
        1_000_000,
      );
      await runs.appendStep(
        run.id,
        WORKER,
        {
          kind: 'start',
          result: { outcome: 'needs_input', summary: '', question: QUESTION },
          question: QUESTION,
          sessionRef: 'session-1',
        },
        WORKING_COPY,
        [],
        T0,
      );
      if (!recorded) runs.runs.find((stored) => stored.id === run.id)!.workingCopy = null;
      await runs.transitionClaimed({
        runId: run.id,
        workerId: WORKER,
        from: 'running',
        to: 'waiting_for_operator',
        failure: null,
        cancelRequested: false,
        now: T0,
      });
      await runs.answer(run.id, 'PostgreSQL', T0);
      return run;
    }

    it('hands an answered Run to resume, with the steps taken and the next seq, keeping its start', async () => {
      const run = await answered(A);
      now = new Date(T0.getTime() + 30_000);

      expect(await handler.execute(WORKER)).toMatchObject({
        id: run.id,
        state: 'preparing',
        claimedBy: WORKER,
        startedAt: T0,
        sessionRef: 'session-1',
        completedSteps: 1,
        nextSeq: 4,
      });
    });

    it('hands it only to the worker that started it, which has its Working copy', async () => {
      const run = await answered(A);

      expect(await handler.execute(OTHER_WORKER)).toBeNull();
      expect((await handler.execute(WORKER))?.id).toBe(run.id);
    });

    it('keeps its place while it waits for its worker', async () => {
      await answered(A);
      const a2 = await queue(A);
      const b1 = await queue(B);
      const c1 = await queue(C);

      expect((await handler.execute(OTHER_WORKER))?.id).toBe(b1.id);
      expect(await handler.execute(OTHER_WORKER)).toBeNull();
      expect((await runs.findById(a2.id))?.state).toBe('queued');
      expect((await runs.findById(c1.id))?.state).toBe('queued');
    });

    it('fails at once a resume with no recorded Working copy, and hands out the next', async () => {
      const run = await answered(A, false);
      const next = await queue(B);

      expect((await handler.execute(WORKER))?.id).toBe(next.id);
      expect(await runs.findById(run.id)).toMatchObject({
        state: 'failed',
        failure: { code: 'preparation_failed', detail: expect.stringContaining('run again') },
        claimedBy: null,
      });
    });

    it('starts a new Run with no steps taken and its events from seq 1', async () => {
      await queue(A);

      expect(await handler.execute(WORKER)).toMatchObject({ completedSteps: 0, nextSeq: 1 });
    });
  });

  it('sweeps lost workers first, which frees their places', async () => {
    const a1 = await queue(A);
    const b1 = await queue(B);
    const c1 = await queue(C);
    await handler.execute(WORKER);
    await handler.execute(WORKER);
    now = new Date(T0.getTime() + 61_000);

    const claimed = await handler.execute(OTHER_WORKER);

    expect(claimed?.id).toBe(c1.id);
    expect((await runs.findById(a1.id))?.failure?.code).toBe('worker_lost');
    expect((await runs.findById(b1.id))?.failure?.code).toBe('worker_lost');
  });

  it('cancels a Run left waiting too long before it hands out work (Issue #100)', async () => {
    const waiting = await queue(A);
    await handler.execute(WORKER);
    for (const [from, to] of [
      ['preparing', 'running'],
      ['running', 'waiting_for_operator'],
    ] as const) {
      await runs.transitionClaimed({
        runId: waiting.id,
        workerId: WORKER,
        from,
        to,
        failure: null,
        cancelRequested: false,
        now: T0,
      });
    }
    const next = await queue(A);
    now = new Date(T0.getTime() + 15 * 24 * 60 * 60 * 1000);

    expect((await handler.execute(WORKER))?.id).toBe(next.id);
    expect(await runs.findById(waiting.id)).toMatchObject({
      state: 'cancelled',
      cancellation: { by: 'system' },
    });
  });

  it("times out a Run whose step ran past its limit plus Studio's grace (review of #121)", async () => {
    const stuck = await queue(A);
    await handler.execute(WORKER);
    await runs.transitionClaimed({
      runId: stuck.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      cancelRequested: false,
      now: T0,
    });
    // The worker keeps sending heartbeats, but its step never stops.
    now = new Date(T0.getTime() + (60 + 5) * 60_000);
    await runs.heartbeat(stuck.id, WORKER, now);
    await handler.execute(OTHER_WORKER);
    expect((await runs.findById(stuck.id))?.state).toBe('running');

    now = new Date(now.getTime() + 1000);
    await runs.heartbeat(stuck.id, WORKER, now);
    await handler.execute(OTHER_WORKER);

    expect(await runs.findById(stuck.id)).toMatchObject({
      state: 'timed_out',
      claimedBy: null,
      finishedAt: now,
    });
  });
});
