import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import type { RecordedWorkerStatus } from '../../../../domain/services/provider-availability.js';
import type { WorkerStatusStore } from '../../../ports/worker-status-store.js';
import { SweepLostWorkersHandler } from '../handler.js';

// Issue #96: a claimed Run whose worker sends no heartbeat within the lease becomes failed
// with worker_lost. The clock is injected, so no test waits.
const PROJECTS = [
  '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
  '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f',
] as const;
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

/** The worker statuses Studio keeps (Issue #101), as the in-memory adapter keeps them. */
class InMemoryWorkerStatusStore implements WorkerStatusStore {
  private readonly seen = new Map<string, RecordedWorkerStatus>();
  record(status: RecordedWorkerStatus) {
    this.seen.set(status.workerId, status);
  }
  latest() {
    return [...this.seen.values()].at(-1);
  }
  lastSeen(workerId: string) {
    return this.seen.get(workerId)?.reportedAt;
  }
}

describe('SweepLostWorkersHandler', () => {
  let runs: InMemoryRunRepository;
  let now: Date;
  let handler: SweepLostWorkersHandler;
  let statuses: InMemoryWorkerStatusStore;
  /** Runs whose Environment file snapshot was released (Issue #104). */
  let released: string[];

  async function claimed(projectId: string) {
    await runs.add({
      projectId,
      provider: 'claude_code',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      integrationBranch: 'dev',
    });
    return (await runs.claimNext(WORKER, T0))!;
  }

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    now = T0;
    statuses = new InMemoryWorkerStatusStore();
    released = [];
    handler = new SweepLostWorkersHandler(runs, { now: () => now }, { seconds: 60 }, statuses, {
      releaseFor: (runId) => Promise.resolve(void released.push(runId)),
      releaseFinal: () => Promise.resolve(),
    });
  });

  it('fails a preparing Run whose last heartbeat is older than the lease', async () => {
    const run = await claimed(PROJECTS[0]);
    now = later(61);

    expect(await handler.execute()).toBe(1);

    expect(await runs.findById(run.id)).toMatchObject({
      state: 'failed',
      failure: {
        code: 'worker_lost',
        detail: 'The agent worker sent no heartbeat for 60 seconds.',
      },
      claimedBy: null,
      finishedAt: later(61),
    });
  });

  it('fails a running Run the same way', async () => {
    const run = await claimed(PROJECTS[0]);
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      cancelRequested: false,
      now: later(30),
    });
    now = later(91);

    expect(await handler.execute()).toBe(1);
    expect((await runs.findById(run.id))?.state).toBe('failed');
  });

  it('keeps a Run whose heartbeat is within the lease', async () => {
    const run = await claimed(PROJECTS[0]);
    await runs.heartbeat(run.id, WORKER, later(50));
    now = later(100);

    expect(await handler.execute()).toBe(0);
    expect((await runs.findById(run.id))?.state).toBe('preparing');
  });

  it('never sweeps a Run waiting for the operator: no worker holds it', async () => {
    const run = await claimed(PROJECTS[0]);
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      cancelRequested: false,
      now: T0,
    });
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'running',
      to: 'waiting_for_operator',
      failure: null,
      cancelRequested: false,
      now: T0,
    });
    now = later(3600);

    expect(await handler.execute()).toBe(0);
    expect((await runs.findById(run.id))?.state).toBe('waiting_for_operator');
  });

  it('leaves queued Runs alone', async () => {
    await runs.add({
      projectId: PROJECTS[1],
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      integrationBranch: 'dev',
    });
    now = later(3600);

    expect(await handler.execute()).toBe(0);
    expect(runs.runs[0]?.state).toBe('queued');
  });

  describe('a requested delivery retry whose worker is gone (review N2 of #122)', () => {
    /** A Run WORKER started, whose delivery failed and whose retry the operator requested. */
    async function pendingRetry() {
      const run = await claimed(PROJECTS[0]);
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
          cancelRequested: false,
          now: T0,
        });
      }
      await runs.requestDeliveryRetry(run.id);
      return run;
    }
    const report = (at: Date) =>
      statuses.record({
        workerId: WORKER,
        runner: 'fake',
        providers: { claude_code: true, codex: true },
        reportedAt: at,
      });

    it('fails it as "Working copy no longer exists (agent worker gone)" and releases it', async () => {
      const run = await pendingRetry();
      report(later(10));
      now = later(71);

      expect(await handler.execute()).toBe(1);

      expect(await runs.findById(run.id)).toMatchObject({
        state: 'failed',
        failure: {
          code: 'delivery_failed',
          detail: expect.stringMatching(/^Working copy no longer exists \(agent worker gone\)/),
        },
        delivery: 'failed',
        deliveryRequested: false,
        claimedBy: null,
      });
      // The Working copy is gone: its Environment file snapshot goes too (Issue #104).
      expect(released).toEqual([run.id]);
    });

    it('keeps it while that worker reports within the lease', async () => {
      const run = await pendingRetry();
      report(later(50));
      now = later(100);

      expect(await handler.execute()).toBe(0);
      expect((await runs.findById(run.id))?.deliveryRequested).toBe(true);
    });

    it('counts a worker never seen since Studio started from that start, not before', async () => {
      const run = await pendingRetry();
      now = later(59);
      expect(await handler.execute()).toBe(0);

      now = later(61);
      expect(await handler.execute()).toBe(1);
      expect((await runs.findById(run.id))?.deliveryRequested).toBe(false);
    });
  });
  describe('an answered Run whose worker is gone (Issue #103)', () => {
    /** A Run WORKER carried to a question, which the operator answered. */
    async function answered() {
      const run = await claimed(PROJECTS[0]);
      await runs.transitionClaimed({
        runId: run.id,
        workerId: WORKER,
        from: 'preparing',
        to: 'running',
        failure: null,
        cancelRequested: false,
        now: T0,
      });
      await runs.appendStep(
        run.id,
        WORKER,
        {
          kind: 'start',
          result: {},
          question: { text: 'Which?' },
          sessionRef: 'session-1',
        },
        { runBranch: 'agent/x', commits: [], hasUncommittedChanges: false },
        [],
        T0,
      );
      await runs.transitionClaimed({
        runId: run.id,
        workerId: WORKER,
        from: 'running',
        to: 'waiting_for_operator',
        failure: null,
        cancelRequested: false,
        now: T0,
      });
      await runs.answer(run.id, 'That one.', T0);
      return run;
    }
    const report = (at: Date) =>
      statuses.record({
        workerId: WORKER,
        runner: 'fake',
        providers: { claude_code: true, codex: true },
        reportedAt: at,
      });

    it('fails it with preparation_failed, "Working copy no longer exists", so it can run again', async () => {
      const run = await answered();
      report(later(10));
      now = later(71);

      expect(await handler.execute()).toBe(1);

      expect(await runs.findById(run.id)).toMatchObject({
        state: 'failed',
        failure: {
          code: 'preparation_failed',
          detail: expect.stringMatching(
            /^Working copy no longer exists \(agent worker gone\) — run again/,
          ),
        },
        finishedAt: later(71),
      });
    });

    it('keeps it while that worker reports within the lease', async () => {
      const run = await answered();
      report(later(50));
      now = later(100);

      expect(await handler.execute()).toBe(0);
      expect((await runs.findById(run.id))?.state).toBe('queued');
    });
  });
});
