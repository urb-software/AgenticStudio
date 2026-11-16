import { BRING_UP_TO_DATE_DEFAULT_TEXT as PROTOCOL_DEFAULT_TEXT } from '@agentic-studio/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BRING_UP_TO_DATE_DEFAULT_TEXT,
  FollowUpNotAllowedError,
  currentUpdateStart,
  inBringUpToDate,
  latestMergedCommit,
  resumeMessage,
  type Run,
  type RunState,
} from '../../../domain/entities/run.js';
import { InMemoryRunLookupRepository } from '../../../domain/repositories/__tests__/in-memory-run-lookup-repository.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { RunNotFoundError } from '../../../domain/repositories/run-repository.js';
import type { RecordedWorkerStatus } from '../../../domain/services/provider-availability.js';
import type { WorkerStatusStore } from '../../../ports/worker-status-store.js';
import { FollowUpRunHandler } from '../../follow-up-run/handler.js';

/** The latest agent worker status and when each worker last reported (Issue #101). */
class InMemoryWorkerStatusStore implements WorkerStatusStore {
  private current: RecordedWorkerStatus | undefined;
  private readonly seen = new Map<string, Date>();
  record(status: RecordedWorkerStatus): void {
    this.current = status;
    this.seen.set(status.workerId, status.reportedAt);
  }
  latest(): RecordedWorkerStatus | undefined {
    return this.current;
  }
  lastSeen(workerId: string): Date | undefined {
    return this.seen.get(workerId);
  }
}

// Issue #147: the operator brings a finished Run's branch up to date with the integration branch.
const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const UNKNOWN_RUN = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const T0 = new Date('2026-11-16T12:00:00.000Z');
const T1 = new Date('2026-11-16T12:30:00.000Z');
const T2 = new Date('2026-11-16T12:45:00.000Z');
const LEASE = { seconds: 60 };
const MERGED = 'b'.repeat(40);
const WORKING_COPY = {
  runBranch: 'agent/x-r0b8e5c2d',
  commits: [{ id: 'a'.repeat(40), subject: 'First' }],
  hasUncommittedChanges: false,
};
const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
const newRun = (maxTotalSteps = 50) => ({
  projectId: PROJECT,
  provider: 'claude_code' as const,
  task: 'Add a health check',
  startCommit: 'a',
  remoteUrl: 'https://git.example.test/a.git',
  limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps },
  integrationBranch: 'dev',
});

describe('bringing the branch up to date (the Follow-up handler with its source)', () => {
  let runs: InMemoryRunRepository;
  let workers: InMemoryWorkerStatusStore;
  let lookups: InMemoryRunLookupRepository;
  let handler: FollowUpRunHandler;
  const bringUp = (runId: string, note: string | undefined) =>
    handler.execute(runId, note ?? '', 'bring_up_to_date');

  function connect(providers = { claude_code: true, codex: true }) {
    workers.record({ workerId: WORKER, runner: 'fake', providers, reportedAt: T1 });
  }

  /** A Run WORKER carried to `end` after `steps` done steps. */
  async function finished(end: RunState = 'succeeded', steps = 1, maxTotalSteps = 50) {
    const added = await runs.add(newRun(maxTotalSteps));
    await runs.claimNext(WORKER, T0);
    await runs.transitionClaimed({
      runId: added.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      cancelRequested: false,
      now: T0,
    });
    for (let index = 1; index <= steps; index++) {
      await runs.appendStep(
        added.id,
        WORKER,
        { kind: 'start', result: { outcome: 'done', summary: 'Done.' }, sessionRef: 'session-1' },
        WORKING_COPY,
        [],
        T0,
      );
    }
    if (end === 'cancelled') await runs.requestCancel(added.id, T0);
    await runs.transitionClaimed({
      runId: added.id,
      workerId: WORKER,
      from: 'running',
      to: end,
      failure: end === 'failed' ? { code: 'agent_failed', detail: 'It failed.' } : null,
      ...(end === 'succeeded'
        ? { delivery: { outcome: 'delivered' as const, pullRequest: PULL_REQUEST } }
        : {}),
      ...(end === 'cancelled'
        ? { cancellation: { by: 'operator' as const, reason: 'Cancelled by the operator.' } }
        : {}),
      cancelRequested: end === 'cancelled',
      now: T0,
    });
    return (await runs.findById(added.id))!;
  }

  /** The Run after its worker claimed the queued request. */
  async function claimed(run: Run): Promise<Run> {
    const next = await runs.claimNext(WORKER, T2);
    expect(next?.id).toBe(run.id);
    return (await runs.findById(run.id))!;
  }

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    workers = new InMemoryWorkerStatusStore();
    lookups = new InMemoryRunLookupRepository(runs);
    handler = new FollowUpRunHandler(runs, { now: () => T1 }, workers, LEASE, lookups);
    connect();
  });

  it('queues the Run as a Follow-up marked bring_up_to_date with the operator note', async () => {
    const run = await finished();

    const { run: queued } = await bringUp(run.id, 'Keep our version of the config.');

    expect(queued).toMatchObject({
      state: 'queued',
      followUpQueued: true,
      followUpCount: 1,
      stepsBeforePart: 1,
      sessionRef: 'session-1',
    });
    expect(queued.messages.at(-1)).toEqual({
      kind: 'follow_up',
      text: 'Keep our version of the config.',
      at: T1,
      source: 'bring_up_to_date',
    });
    expect(inBringUpToDate(queued)).toBe(true);
    expect(resumeMessage(queued)).toEqual({
      text: 'Keep our version of the config.',
      reason: 'bring_up_to_date',
    });
  });

  it('stores no text without a note and hands the worker a default one', async () => {
    const run = await finished();

    const { run: queued } = await bringUp(run.id, undefined);

    expect(queued.messages.at(-1)).toMatchObject({ kind: 'follow_up', text: '' });
    expect(resumeMessage(queued)).toEqual({
      text: BRING_UP_TO_DATE_DEFAULT_TEXT,
      reason: 'bring_up_to_date',
    });
  });

  it("hands the worker the worker protocol's default text, not a copy that could drift", () => {
    expect(BRING_UP_TO_DATE_DEFAULT_TEXT).toBe(PROTOCOL_DEFAULT_TEXT);
  });

  it('records how the part before it ended, like any Follow-up', async () => {
    const run = await finished('failed');

    const { run: queued } = await bringUp(run.id, undefined);

    expect(queued.messages.at(-2)).toMatchObject({
      kind: 'part_end',
      state: 'failed',
      failureCode: 'agent_failed',
      detail: 'It failed.',
    });
  });

  it('refuses for the Follow-up reasons, and a second request while one is queued', async () => {
    const run = await finished();
    const waiting = await runs.add(newRun());
    await expect(bringUp(waiting.id, undefined)).rejects.toMatchObject({
      reason: 'not_finished',
    });
    await bringUp(run.id, undefined);
    await expect(bringUp(run.id, undefined)).rejects.toMatchObject({
      reason: 'follow_up_queued',
    });
    await expect(bringUp(run.id, 'x')).rejects.toBeInstanceOf(FollowUpNotAllowedError);
  });

  it('counts against the Run step total like a Follow-up', async () => {
    const run = await finished('succeeded', 2, 2);

    await expect(bringUp(run.id, undefined)).rejects.toMatchObject({
      reason: 'step_total_reached',
    });
  });

  it('is refused while the agent worker is away, or the Provider is off', async () => {
    const run = await finished();
    workers.record({
      workerId: WORKER,
      runner: 'fake',
      providers: { claude_code: false, codex: true },
      reportedAt: T1,
    });
    await expect(bringUp(run.id, undefined)).rejects.toMatchObject({
      reason: 'provider_unavailable',
    });
  });

  it('answers an unknown Run with RunNotFoundError', async () => {
    await expect(bringUp(UNKNOWN_RUN, undefined)).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(bringUp('not-a-run-id', undefined)).rejects.toBeInstanceOf(RunNotFoundError);
  });

  describe('what the worker reports', () => {
    it('records where the merge started, once, only while the worker holds the Run', async () => {
      const run = await finished();
      await bringUp(run.id, 'Note.');
      await claimed(run);
      const start = { baseCommit: 'a'.repeat(40), integrationCommit: MERGED };

      expect(await runs.recordUpdateStart(run.id, 'someone-else', start)).toBe(false);
      expect(await runs.recordUpdateStart(run.id, WORKER, start)).toBe(true);
      expect(
        await runs.recordUpdateStart(run.id, WORKER, {
          ...start,
          integrationCommit: 'c'.repeat(40),
        }),
      ).toBe(false);

      const stored = (await runs.findById(run.id))!;
      expect(stored.messages.at(-1)).toMatchObject({
        kind: 'follow_up',
        source: 'bring_up_to_date',
        updateBase: 'a'.repeat(40),
        updateTip: MERGED,
      });
      expect(currentUpdateStart(stored)).toEqual({ updateBase: 'a'.repeat(40), updateTip: MERGED });
      // Not merged until the part succeeded.
      expect(latestMergedCommit(stored)).toBeUndefined();
      expect(await runs.recordMergedCommit(run.id)).toBe(true);
      expect(await runs.recordMergedCommit(run.id)).toBe(false);
      expect(latestMergedCommit((await runs.findById(run.id))!)).toBe(MERGED);
    });

    it('records no merge on a Follow-up that is not a bring-up request or never started one', async () => {
      const run = await finished();
      await runs.queueFollowUp(run.id, 'Plain.', T1);
      await claimed(run);
      expect(
        await runs.recordUpdateStart(run.id, WORKER, {
          baseCommit: 'a'.repeat(40),
          integrationCommit: MERGED,
        }),
      ).toBe(false);
      expect(await runs.recordMergedCommit(run.id)).toBe(false);
      expect(currentUpdateStart((await runs.findById(run.id))!)).toBeUndefined();
    });

    it('has no merged commit to record for a request whose merge never started', async () => {
      const run = await finished();
      await bringUp(run.id, undefined);
      await claimed(run);

      expect(await runs.recordMergedCommit(run.id)).toBe(false);
    });

    it.each([
      ['succeeded', 'delivered'],
      ['failed', null],
      ['cancelled', null],
      ['timed_out', null],
    ] as const)(
      'returns a %s Run to its earlier result when the branch was already up to date',
      async (end, delivery) => {
        const run = await finished(end);
        await bringUp(run.id, undefined);
        await claimed(run);

        const restored = await runs.finishBringUpToDate(run.id, WORKER, 'Already up to date.', T2);

        expect(restored).toMatchObject({
          state: end,
          claimedBy: null,
          releasedBy: WORKER,
          finishedAt: T2,
          delivery,
          // The pull request stays; nothing was pushed and no step was taken.
          pullRequest: end === 'succeeded' ? PULL_REQUEST : null,
          stepCount: 1,
        });
        if (end === 'failed') {
          expect(restored?.failure).toEqual({ code: 'agent_failed', detail: 'It failed.' });
        }
        if (end === 'cancelled') {
          expect(restored?.cancellation).toEqual({
            by: 'operator',
            reason: 'Cancelled by the operator.',
          });
        }
        expect(restored?.messages.at(-1)).toMatchObject({
          kind: 'part_end',
          state: end,
          detail: 'Already up to date.',
        });
        // Not a pending request any more: another can be made.
        const again = await bringUp(run.id, undefined);
        expect(again.run.followUpCount).toBe(2);
      },
    );

    it('is refused for a worker that does not hold the Run, or for a plain Follow-up', async () => {
      const run = await finished();
      await bringUp(run.id, undefined);
      await claimed(run);
      expect(await runs.finishBringUpToDate(run.id, 'someone-else', 'x', T2)).toBeNull();

      const other = await finished();
      await runs.queueFollowUp(other.id, 'Plain.', T1);
      // Held by nobody yet: not a request to bring up to date, nothing to return to.
      expect(await runs.finishBringUpToDate(other.id, WORKER, 'x', T2)).toBeNull();
    });
  });
});
