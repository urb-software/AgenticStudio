import { beforeEach, describe, expect, it } from 'vitest';
import type { EnvironmentFile } from '@agentic-studio/contracts';
import { RUN_ENVIRONMENT_FILE_SECRET_OWNER } from '../../../domain/entities/run-environment-file.js';
import { InMemoryRunLogRepository } from '../../../domain/repositories/__tests__/in-memory-run-log-repository.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { InMemorySecretStore } from '../../../ports/__tests__/in-memory-secret-store.js';
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
  let secrets: InMemorySecretStore;
  /** Runs whose Environment file snapshot was released (Issue #104). */
  let released: string[];
  // Each project's current Environment file (Issue #104); test values only.
  let files: Map<string, EnvironmentFile>;
  let filesFail: Error | undefined;

  const queue = (projectId: string) =>
    runs.add({
      projectId,
      provider: 'claude_code',
      task: `Task of ${projectId}`,
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      integrationBranch: 'dev',
    });

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    logs = new InMemoryRunLogRepository(runs);
    now = T0;
    secrets = new InMemorySecretStore();
    released = [];
    files = new Map();
    filesFail = undefined;
    const environmentFiles = {
      forProject: (projectId: string) =>
        filesFail ? Promise.reject(filesFail) : Promise.resolve(files.get(projectId) ?? null),
    };
    handler = new ClaimRunHandler(
      runs,
      logs,
      { now: () => now },
      { seconds: 60 },
      environmentFiles,
      secrets,
      {
        releaseFor: (runId) => Promise.resolve(void released.push(runId)),
        releaseFinal: () => Promise.resolve(),
      },
    );
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
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
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

    it('hands out a retry without the Environment file content, keeping its recorded path (#104)', async () => {
      const run = await queue(A);
      await runs.claimNext(WORKER, T0);
      await runs.attachEnvironmentFile(run.id, WORKER, { path: '.env', secretRef: 'x' });
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
          workingCopy: to === 'failed' ? WORKING_COPY : null,
          cancelRequested: false,
          now: T0,
        });
      }
      await runs.requestDeliveryRetry(run.id);
      files.set(A, { path: 'other.env', content: 'A=test-only-later' });

      expect(await handler.execute(WORKER)).toMatchObject({
        id: run.id,
        state: 'failed',
        environmentFilePath: '.env',
        environmentFile: null,
      });
      expect(secrets.values.size).toBe(0);
    });

    it('continues the log of a retry after the stored events, with the steps taken (#103)', async () => {
      const run = await queue(A);
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
        [1, 2, 3, 4, 5].map((seq) => ({
          seq,
          at: T0,
          stepIndex: 1,
          kind: 'message' as const,
          text: 'x',
          truncated: false,
        })),
        1_000_000,
      );
      await runs.appendStep(run.id, WORKER, { kind: 'start', result: {} }, WORKING_COPY, [], T0);
      await runs.transitionClaimed({
        runId: run.id,
        workerId: WORKER,
        from: 'running',
        to: 'failed',
        failure: { code: 'delivery_failed', detail: 'refused' },
        workingCopy: WORKING_COPY,
        cancelRequested: false,
        now: T0,
      });
      await runs.requestDeliveryRetry(run.id);

      expect(await handler.execute(WORKER)).toMatchObject({
        id: run.id,
        state: 'failed',
        completedSteps: 1,
        nextSeq: 6,
      });
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
      // Nothing left to deliver: its Environment file snapshot goes (Issue #104).
      expect(released).toEqual([run.id]);
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

    it('hands a resume without the Environment file content, keeping its snapshot and path (#104)', async () => {
      files.set(A, { path: '.env', content: 'A=test-only-1' });
      const queued = await queue(A);
      const started = await handler.execute(WORKER);
      expect(started?.environmentFile).not.toBeNull();
      const snapshot = await runs.findEnvironmentFileSecret(queued.id);
      // Carry the started Run to a question and answer it (the helper does it for a new Run).
      await runs.transitionClaimed({
        runId: queued.id,
        workerId: WORKER,
        from: 'preparing',
        to: 'running',
        failure: null,
        cancelRequested: false,
        now: T0,
      });
      await runs.appendStep(
        queued.id,
        WORKER,
        { kind: 'start', result: {}, question: QUESTION, sessionRef: 'session-1' },
        WORKING_COPY,
        [],
        T0,
      );
      await runs.transitionClaimed({
        runId: queued.id,
        workerId: WORKER,
        from: 'running',
        to: 'waiting_for_operator',
        failure: null,
        cancelRequested: false,
        now: T0,
      });
      await runs.answer(queued.id, 'Yes', T0);
      files.set(A, { path: 'other.env', content: 'A=test-only-later' });

      expect(await handler.execute(WORKER)).toMatchObject({
        id: queued.id,
        environmentFilePath: '.env',
        environmentFile: null,
      });
      expect(await runs.findEnvironmentFileSecret(queued.id)).toBe(snapshot);
      expect(secrets.values.size).toBe(1);
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

  it("stops Studio's step clock once the step result is reported: a slow delivery is not timed out", async () => {
    const delivering = await queue(A);
    await handler.execute(WORKER);
    await runs.transitionClaimed({
      runId: delivering.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      cancelRequested: false,
      now: T0,
    });
    await runs.appendStep(
      delivering.id,
      WORKER,
      { kind: 'start', result: { outcome: 'done', summary: 'x' } },
      { runBranch: 'agent/x', commits: [], hasUncommittedChanges: false },
      [],
      T0,
    );
    // The push and pull request take long; the worker keeps sending heartbeats.
    now = new Date(T0.getTime() + 2 * 60 * 60_000);
    await runs.heartbeat(delivering.id, WORKER, now);
    await handler.execute(OTHER_WORKER);

    expect((await runs.findById(delivering.id))?.state).toBe('running');
  });
});

describe('ClaimRunHandler with Environment files (Issue #104)', () => {
  const FILE = { path: '.env', content: 'DB_PASSWORD=test-only-pw-1\n' };
  let runs: InMemoryRunRepository;
  let secrets: InMemorySecretStore;
  let current: EnvironmentFile | null;
  let failRead: Error | undefined;
  let handler: ClaimRunHandler;

  const queue = () =>
    runs.add({
      projectId: A,
      provider: 'claude_code',
      task: 'Run the integration tests',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      integrationBranch: 'dev',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
    });

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    secrets = new InMemorySecretStore();
    current = FILE;
    failRead = undefined;
    handler = new ClaimRunHandler(
      runs,
      new InMemoryRunLogRepository(runs),
      { now: () => T0 },
      { seconds: 60 },
      {
        forProject: () =>
          failRead ? Promise.reject(failRead) : Promise.resolve(current && { ...current }),
      },
      secrets,
      {
        releaseFor: async (runId) => {
          const ref = await runs.findEnvironmentFileSecret(runId);
          if (ref === null) return;
          await secrets.delete(ref);
          await runs.clearEnvironmentFileSecret(runId, ref);
        },
        releaseFinal: () => Promise.resolve(),
      },
    );
  });

  /** The claimed Run carried by WORKER through one done step to `succeeded`. */
  async function finish(runId: string) {
    await runs.transitionClaimed({
      runId,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      cancelRequested: false,
      now: T0,
    });
    await runs.appendStep(
      runId,
      WORKER,
      { kind: 'start', result: {}, sessionRef: 'session-1' },
      { runBranch: 'agent/x-r0b8e5c2d', commits: [], hasUncommittedChanges: false },
      [],
      T0,
    );
    await runs.transitionClaimed({
      runId,
      workerId: WORKER,
      from: 'running',
      to: 'succeeded',
      failure: null,
      delivery: { outcome: 'none' },
      cancelRequested: false,
      now: T0,
    });
  }

  // Review S3 of #150: a Follow-up works with the Project's current Environment file.
  it("takes a new snapshot of the Project's current file for a Follow-up, replacing the earlier one", async () => {
    const queued = await queue();
    await handler.execute(WORKER);
    const first = await runs.findEnvironmentFileSecret(queued.id);
    await finish(queued.id);
    await runs.queueFollowUp(queued.id, 'Go on.', T0);
    current = { path: 'config/.env', content: 'DB_PASSWORD=test-only-new\n' };

    const claimed = await handler.execute(WORKER);

    expect(claimed).toMatchObject({
      id: queued.id,
      replaceEnvironmentFile: true,
      environmentFile: current,
      environmentFileSupplied: true,
      environmentFilePath: 'config/.env',
      studioPaths: ['.env', 'config/.env'],
    });
    expect(secrets.values.has(first!)).toBe(false);
    const snapshot = await runs.findEnvironmentFileSecret(queued.id);
    expect(secrets.values.get(snapshot!)).toBe('DB_PASSWORD=test-only-new\n');
  });

  it('goes on without a file when the Project has none now, and the earlier file is removed', async () => {
    const queued = await queue();
    await handler.execute(WORKER);
    await finish(queued.id);
    await runs.queueFollowUp(queued.id, 'Go on.', T0);
    current = null;

    const claimed = await handler.execute(WORKER);

    expect(claimed).toMatchObject({
      replaceEnvironmentFile: true,
      environmentFile: null,
      environmentFileSupplied: false,
      studioPaths: ['.env'],
    });
    expect(await runs.findEnvironmentFileSecret(queued.id)).toBeNull();
    expect(secrets.values.size).toBe(0);
  });

  it('keeps the snapshot for an answer, and fails a Follow-up whose Working copy was removed', async () => {
    const queued = await queue();
    await handler.execute(WORKER);
    await finish(queued.id);
    await runs.queueFollowUp(queued.id, 'Go on.', T0);
    // Review S9 of #150: the worker's retention removed it while the Follow-up waited.
    await runs.markWorkingCopiesRemoved(WORKER, [queued.id], T0);

    expect(await handler.execute(WORKER)).toBeNull();
    expect(await runs.findById(queued.id)).toMatchObject({
      state: 'failed',
      failure: {
        code: 'preparation_failed',
        detail:
          "Working copy no longer exists — run again: the agent worker's retention removed it.",
      },
    });
  });

  it("hands the Project's file to the claiming worker and keeps a Run-scoped snapshot", async () => {
    const queued = await queue();

    const claimed = await handler.execute(WORKER);

    expect(claimed).toMatchObject({ id: queued.id, environmentFileSupplied: true });
    expect(claimed?.environmentFile).toEqual(FILE);
    expect((await runs.findById(queued.id))?.environmentFileSupplied).toBe(true);
    const snapshot = await runs.findEnvironmentFileSecret(queued.id);
    expect(secrets.values.get(snapshot!)).toBe(FILE.content);
    expect(secrets.owners.get(snapshot!)).toBe(RUN_ENVIRONMENT_FILE_SECRET_OWNER);
  });

  it('keeps the snapshot of the claim when the file changes or goes afterwards', async () => {
    const queued = await queue();
    await handler.execute(WORKER);

    current = { path: '.env', content: 'DB_PASSWORD=test-only-changed\n' };
    const snapshot = await runs.findEnvironmentFileSecret(queued.id);

    expect(secrets.values.get(snapshot!)).toBe(FILE.content);
  });

  it('records that no file was supplied when the Project has none', async () => {
    current = null;
    const queued = await queue();

    const claimed = await handler.execute(WORKER);

    expect(claimed).toMatchObject({ environmentFileSupplied: false, environmentFile: null });
    expect(await runs.findEnvironmentFileSecret(queued.id)).toBeNull();
    expect(secrets.values.size).toBe(0);
  });

  it('fails the Run with preparation_failed when the file cannot be read, handing out nothing', async () => {
    failRead = new Error('The secret could not be decrypted.');
    const queued = await queue();

    expect(await handler.execute(WORKER)).toBeNull();
    expect(await runs.findById(queued.id)).toMatchObject({
      state: 'failed',
      failure: { code: 'preparation_failed' },
      environmentFileSupplied: false,
    });
  });

  it('fails the Run and stores nothing when the snapshot cannot be stored', async () => {
    secrets.failWith = new Error('The secret store is unavailable.');
    const queued = await queue();

    expect(await handler.execute(WORKER)).toBeNull();
    expect((await runs.findById(queued.id))?.failure?.code).toBe('preparation_failed');
    secrets.failWith = undefined;
    expect(secrets.values.size).toBe(0);
  });
});
