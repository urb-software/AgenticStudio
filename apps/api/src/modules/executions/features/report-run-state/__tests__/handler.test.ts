import { beforeEach, describe, expect, it } from 'vitest';
import { IllegalRunTransitionError, type Run } from '../../../domain/entities/run.js';
import { InMemoryRunLookupRepository } from '../../../domain/repositories/__tests__/in-memory-run-lookup-repository.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { RunNotFoundError, RunNotHeldError } from '../../../domain/repositories/run-repository.js';
import { ReportRunStateHandler, type ReportRunStateInput } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const UNKNOWN_RUN = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T12:05:00.000Z');

describe('ReportRunStateHandler', () => {
  let runs: InMemoryRunRepository;
  let handler: ReportRunStateHandler;
  let run: Run;
  let notified: string[];
  /** The Runs whose Environment file snapshot the handler released (Issue #104). */
  let released: string[];
  let lookups: InMemoryRunLookupRepository;

  const report = (input: Partial<ReportRunStateInput>) =>
    handler.execute({ runId: run.id, workerId: WORKER, state: 'running', failure: null, ...input });

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    lookups = new InMemoryRunLookupRepository(runs);
    notified = [];
    released = [];
    handler = new ReportRunStateHandler(
      runs,
      { now: () => T1 },
      { notify: (runId) => notified.push(runId), subscribe: () => () => undefined },
      {
        releaseFor: (runId) => Promise.resolve(void released.push(runId)),
        releaseFinal: () => Promise.resolve(),
      },
      { forRun: () => Promise.resolve(['test-only-known']) },
      lookups,
    );
    await runs.add({
      projectId: PROJECT,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      integrationBranch: 'dev',
    });
    run = (await runs.claimNext(WORKER, T0))!;
    // Supplied an Environment file, so its snapshot is released once the Run is done (#104).
    await runs.attachEnvironmentFile(run.id, WORKER, { path: '.env', secretRef: 'snapshot' });
  });

  it('moves a preparing Run to running, still held', async () => {
    expect(await report({ state: 'running' })).toMatchObject({
      state: 'running',
      claimedBy: WORKER,
      finishedAt: null,
    });
  });

  it('finishes a running Run as succeeded and releases it', async () => {
    await report({ state: 'running' });

    expect(await report({ state: 'succeeded' })).toMatchObject({
      state: 'succeeded',
      claimedBy: null,
      finishedAt: T1,
      failure: null,
    });
  });

  it("releases the Run's Environment file snapshot once it is final, not before (Issue #104)", async () => {
    await report({ state: 'running' });
    expect(released).toEqual([]);

    await report({ state: 'succeeded', delivery: { outcome: 'none' } });

    expect(released).toEqual([run.id]);
  });

  // Review S4 of #152: the state the worker read before it refused a Follow-up is recorded.
  it('records the pull request state a refused Follow-up read, with the failure', async () => {
    runs.runs.find((candidate) => candidate.id === run.id)!.pullRequest = {
      url: 'https://github.com/acme/shop/pull/7',
      number: 7,
    };
    await report({ state: 'running' });

    await report({
      state: 'failed',
      failure: { code: 'preparation_failed', detail: 'The pull request #7 was merged.' },
      pullRequestState: 'merged',
    });

    const stored = runs.runs.find((candidate) => candidate.id === run.id)!;
    expect(stored.state).toBe('failed');
    expect(stored.pullRequestStatus).toMatchObject({ state: 'merged', refreshedAt: T1 });
  });

  // Review N1 of #152: what an ended pull request cannot have is cleared with the state.
  it.each([
    ['merged', { behindBy: null, aheadBy: null, mergeable: null, checks: null }],
    ['missing', { behindBy: null, aheadBy: null, mergeable: null, checks: null }],
    ['closed', { behindBy: 2, aheadBy: 3, mergeable: null, checks: null }],
  ] as const)(
    'clears what a %s pull request cannot have when its state was read before a refused Follow-up',
    async (state, expected) => {
      const stored = runs.runs.find((candidate) => candidate.id === run.id)!;
      stored.pullRequest = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
      stored.pullRequestStatus = {
        ...stored.pullRequestStatus,
        state: 'open',
        behindBy: 2,
        aheadBy: 3,
        mergeable: true,
        refreshedAt: T0,
        checks: { commit: 'c'.repeat(40), checks: [] },
      };
      await report({ state: 'running' });

      await report({
        state: 'failed',
        failure: { code: 'preparation_failed', detail: 'The pull request #7 is not open.' },
        pullRequestState: state,
      });

      expect(stored.pullRequestStatus).toMatchObject({ state, ...expected });
    },
  );

  it('records no pull request state with any other failure', async () => {
    runs.runs.find((candidate) => candidate.id === run.id)!.pullRequest = {
      url: 'https://github.com/acme/shop/pull/7',
      number: 7,
    };
    await report({ state: 'running' });

    await report({
      state: 'failed',
      failure: { code: 'agent_failed', detail: 'x' },
      pullRequestState: 'merged',
    });

    expect(runs.runs.find((candidate) => candidate.id === run.id)!.pullRequestStatus.state).toBe(
      null,
    );
  });

  it('redacts known values from the failure detail and commit subjects before storing them (#104)', async () => {
    await report({ state: 'running' });

    const failed = await report({
      state: 'failed',
      failure: { code: 'agent_failed', detail: 'login with test-only-known failed' },
      workingCopy: {
        runBranch: 'agent/x-r0b8e5c2d',
        commits: [{ id: 'c'.repeat(40), subject: 'Use test-only-known' }],
        hasUncommittedChanges: false,
      },
    });

    expect(failed.failure?.detail).toBe('login with ••••••[redacted] failed');
    expect(failed.workingCopy?.commits[0]?.subject).toBe('Use ••••••[redacted]');
  });

  it('keeps the snapshot of a Run waiting for the operator (not final)', async () => {
    await report({ state: 'running' });
    await report({ state: 'waiting_for_operator' });

    expect(released).toEqual([]);
  });

  it('wakes the live log streams of the Run on every change, so they can end (Issue #99)', async () => {
    await report({ state: 'running' });
    await report({ state: 'succeeded' });

    expect(notified).toEqual([run.id, run.id]);
  });

  it("records a failed Run's Working copy state with its failure (Issue #98)", async () => {
    await report({ state: 'running' });
    const workingCopy = {
      runBranch: 'agent/x-r0b8e5c2d',
      commits: [{ id: 'c'.repeat(40), subject: 'Half done' }],
      hasUncommittedChanges: true,
    };

    await report({
      state: 'failed',
      failure: { code: 'agent_failed', detail: 'exit 1' },
      workingCopy,
    });

    expect((await runs.findById(run.id))?.workingCopy).toEqual(workingCopy);
  });

  it('keeps the last Working copy state when a failure brings none', async () => {
    await report({ state: 'running' });
    const workingCopy = { runBranch: 'agent/x', commits: [], hasUncommittedChanges: false };
    await runs.appendStep(run.id, WORKER, { kind: 'start', result: {} }, workingCopy, [], T0);

    await report({ state: 'failed', failure: { code: 'unknown', detail: 'x' } });

    expect((await runs.findById(run.id))?.workingCopy).toEqual(workingCopy);
  });

  it('records the failure of a failed Run', async () => {
    const failure = { code: 'agent_failed', detail: 'The agent exited with code 1.' } as const;

    expect(await report({ state: 'failed', failure })).toMatchObject({
      state: 'failed',
      failure,
      finishedAt: T1,
    });
  });

  it('releases a Run that waits for the operator', async () => {
    await report({ state: 'running' });

    expect(await report({ state: 'waiting_for_operator' })).toMatchObject({
      state: 'waiting_for_operator',
      claimedBy: null,
      finishedAt: null,
    });
  });

  it('rejects an illegal transition and changes nothing', async () => {
    await expect(report({ state: 'succeeded' })).rejects.toEqual(
      new IllegalRunTransitionError('preparing', 'succeeded'),
    );
    expect((await runs.findById(run.id))?.state).toBe('preparing');
  });

  it('rejects a report from a worker that does not hold the Run', async () => {
    await expect(report({ workerId: OTHER_WORKER })).rejects.toBeInstanceOf(RunNotHeldError);
  });

  it('rejects a report on a Run the worker released', async () => {
    await report({ state: 'running' });
    await report({ state: 'succeeded' });

    await expect(report({ state: 'running' })).rejects.toBeInstanceOf(RunNotHeldError);
  });

  describe('delivery (Issue #102)', () => {
    const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
    const DELIVERY_FAILED = {
      code: 'delivery_failed',
      detail: 'Pushing the Run branch was refused.',
    } as const;

    it('records the pull request of a delivered Run', async () => {
      await report({ state: 'running' });

      expect(
        await report({
          state: 'succeeded',
          delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
        }),
      ).toMatchObject({ state: 'succeeded', delivery: 'delivered', pullRequest: PULL_REQUEST });
    });

    it('records "No changes" as the delivery none, without a pull request', async () => {
      await report({ state: 'running' });

      expect(await report({ state: 'succeeded', delivery: { outcome: 'none' } })).toMatchObject({
        state: 'succeeded',
        delivery: 'none',
        pullRequest: null,
      });
    });

    it('records a failed delivery as the delivery failed', async () => {
      await report({ state: 'running' });

      expect(await report({ state: 'failed', failure: DELIVERY_FAILED })).toMatchObject({
        state: 'failed',
        failure: DELIVERY_FAILED,
        delivery: 'failed',
      });
    });

    /** A failed delivery whose retry the operator requested and `WORKER` claimed. */
    async function heldRetry() {
      await report({ state: 'running' });
      await report({ state: 'failed', failure: DELIVERY_FAILED });
      await runs.requestDeliveryRetry(run.id);
      expect((await runs.claimNext(WORKER, T1))?.id).toBe(run.id);
    }

    it('turns a failed delivery into succeeded when its retry delivers', async () => {
      await heldRetry();
      const workingCopy = { runBranch: 'agent/x', commits: [], hasUncommittedChanges: false };

      expect(
        await report({
          state: 'succeeded',
          delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
          workingCopy,
        }),
      ).toMatchObject({
        state: 'succeeded',
        failure: null,
        delivery: 'delivered',
        pullRequest: PULL_REQUEST,
        deliveryRequested: false,
        claimedBy: null,
        finishedAt: T1,
        workingCopy,
      });
    });

    it('keeps a Run failed with the new reason when its retry fails again', async () => {
      await heldRetry();
      const again = { code: 'delivery_failed', detail: 'GitHub answered 503.' } as const;

      expect(await report({ state: 'failed', failure: again })).toMatchObject({
        state: 'failed',
        failure: again,
        delivery: 'failed',
        deliveryRequested: false,
        claimedBy: null,
      });
    });

    it('keeps the snapshot of a failed delivery, redacts what its retry reports, and releases it once delivered (#104)', async () => {
      await heldRetry();
      // The failed delivery can be retried: its Environment file snapshot stays.
      expect(released).toEqual([]);

      const failedAgain = await report({
        state: 'failed',
        failure: { code: 'delivery_failed', detail: 'push of test-only-known refused' },
        workingCopy: {
          runBranch: 'agent/x',
          commits: [{ id: 'c'.repeat(40), subject: 'agent: used test-only-known' }],
          hasUncommittedChanges: false,
        },
      });
      expect(failedAgain.failure?.detail).toBe('push of ••••••[redacted] refused');
      expect(failedAgain.workingCopy?.commits[0]?.subject).toBe('agent: used ••••••[redacted]');
      expect(released).toEqual([]);

      await runs.requestDeliveryRetry(run.id);
      expect((await runs.claimNext(WORKER, T1))?.id).toBe(run.id);
      await report({
        state: 'succeeded',
        delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
        workingCopy: { runBranch: 'agent/x', commits: [], hasUncommittedChanges: false },
      });
      expect(released).toEqual([run.id]);
    });

    it('accepts no other outcome of a delivery retry', async () => {
      await heldRetry();

      await expect(report({ state: 'running' })).rejects.toBeInstanceOf(IllegalRunTransitionError);
      await expect(report({ state: 'succeeded' })).rejects.toBeInstanceOf(
        IllegalRunTransitionError,
      );
      await expect(
        report({ state: 'failed', failure: { code: 'agent_failed', detail: 'x' } }),
      ).rejects.toBeInstanceOf(IllegalRunTransitionError);
      expect((await runs.findById(run.id))?.claimedBy).toBe(WORKER);
    });

    it('rejects a delivery outcome from a worker that does not hold the retry', async () => {
      await heldRetry();

      await expect(
        report({ workerId: OTHER_WORKER, state: 'succeeded', delivery: { outcome: 'none' } }),
      ).rejects.toBeInstanceOf(RunNotHeldError);
    });
  });

  it('rejects an unknown Run, also an id that is not a UUID', async () => {
    await expect(report({ runId: UNKNOWN_RUN })).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(report({ runId: 'nope' })).rejects.toBeInstanceOf(RunNotFoundError);
  });

  // Issue #100: cancel confirmation, time limit, and a cancel that overtakes a step's end.
  describe('cancel and time limit', () => {
    it('ends a running Run as cancelled when the worker confirms a requested cancel', async () => {
      await report({ state: 'running' });
      await runs.requestCancel(run.id, T0);
      const workingCopy = { runBranch: 'agent/x', commits: [], hasUncommittedChanges: true };

      expect(await report({ state: 'cancelled', workingCopy })).toMatchObject({
        state: 'cancelled',
        cancellation: { by: 'operator', reason: 'Cancelled by the operator.' },
        claimedBy: null,
        finishedAt: T1,
        workingCopy,
      });
    });

    it('confirms a cancel requested while the Run was still preparing', async () => {
      await runs.requestCancel(run.id, T0);

      expect(await report({ state: 'cancelled' })).toMatchObject({ state: 'cancelled' });
    });

    it('refuses a cancelled report nobody asked for', async () => {
      await report({ state: 'running' });

      await expect(report({ state: 'cancelled' })).rejects.toBeInstanceOf(
        IllegalRunTransitionError,
      );
      expect((await runs.findById(run.id))?.state).toBe('running');
    });

    it('ends the Run as cancelled when its step ends waiting for the operator after a cancel request', async () => {
      await report({ state: 'running' });
      await runs.requestCancel(run.id, T0);

      expect(await report({ state: 'waiting_for_operator' })).toMatchObject({
        state: 'cancelled',
        cancellation: { by: 'operator' },
        waitingSince: null,
      });
    });

    it('keeps a succeeded report with its delivery after a cancel request (the push was done)', async () => {
      await report({ state: 'running' });
      await runs.requestCancel(run.id, T0);

      expect(await report({ state: 'succeeded', delivery: { outcome: 'none' } })).toMatchObject({
        state: 'succeeded',
        delivery: 'none',
        cancellation: null,
      });
    });

    it('keeps a failure a failure after a cancel request', async () => {
      await report({ state: 'running' });
      await runs.requestCancel(run.id, T0);
      const failure = { code: 'agent_failed', detail: 'exit 1' } as const;

      expect(await report({ state: 'failed', failure })).toMatchObject({
        state: 'failed',
        failure,
      });
    });

    it('ends a Run step stopped at its time limit as timed_out, keeping the Working copy state', async () => {
      await report({ state: 'running' });
      const workingCopy = { runBranch: 'agent/x', commits: [], hasUncommittedChanges: false };

      expect(await report({ state: 'timed_out', workingCopy })).toMatchObject({
        state: 'timed_out',
        failure: null,
        cancellation: null,
        claimedBy: null,
        finishedAt: T1,
        workingCopy,
      });
    });

    it('records when a Run began waiting for the operator', async () => {
      await report({ state: 'running' });

      expect(await report({ state: 'waiting_for_operator' })).toMatchObject({ waitingSince: T1 });
    });
  });

  // Review of #121: a retried report whose answer was lost changes nothing and succeeds.
  describe('retried reports', () => {
    it('accepts a repeated running report as a no-op', async () => {
      const first = await report({ state: 'running' });

      expect(await report({ state: 'running' })).toEqual(first);
    });

    it('accepts a repeated end report from the worker that ended the Run', async () => {
      await report({ state: 'running' });
      const done = await report({ state: 'succeeded' });

      expect(await report({ state: 'succeeded' })).toEqual(done);
      await expect(report({ state: 'succeeded', workerId: OTHER_WORKER })).rejects.toBeInstanceOf(
        RunNotHeldError,
      );
    });

    it('accepts a repeated waiting report, and a repeat that became cancelled', async () => {
      await report({ state: 'running' });
      await runs.requestCancel(run.id, T0);
      const cancelled = await report({ state: 'waiting_for_operator' });

      expect(cancelled.state).toBe('cancelled');
      expect(await report({ state: 'waiting_for_operator' })).toEqual(cancelled);
    });

    it('still refuses a different end report after the Run ended', async () => {
      await report({ state: 'running' });
      await report({ state: 'succeeded' });

      await expect(
        report({ state: 'failed', failure: { code: 'unknown', detail: 'x' } }),
      ).rejects.toBeInstanceOf(RunNotHeldError);
    });
  });

  // Review round 2 of #121: a cancel that lands during the delivery leaves a trace.
  it('records the pull request a delivery opened on a Run cancelled during it', async () => {
    await report({ state: 'running' });
    await runs.requestCancel(run.id, T0);
    const pullRequest = { url: 'https://github.com/acme/shop/pull/9', number: 9 };

    expect(
      await report({ state: 'cancelled', delivery: { outcome: 'delivered', pullRequest } }),
    ).toMatchObject({
      state: 'cancelled',
      cancellation: { by: 'operator' },
      delivery: 'delivered',
      pullRequest,
    });
  });

  it('records a pushed Run branch without a pull request on a Run cancelled during its delivery', async () => {
    await report({ state: 'running' });
    await runs.requestCancel(run.id, T0);

    expect(
      await report({ state: 'cancelled', delivery: { outcome: 'none', branchPushed: true } }),
    ).toMatchObject({
      state: 'cancelled',
      delivery: 'none',
      pullRequest: null,
      cancellation: {
        by: 'operator',
        reason:
          'Cancelled by the operator during its delivery: the Run branch was pushed, no pull request was opened.',
      },
    });
  });

  describe('a Run stopped at the usage limit (Issue #105)', () => {
    const WORKING_COPY = { runBranch: 'agent/x-r1', commits: [], hasUncommittedChanges: false };
    const USAGE_LIMIT = { code: 'usage_limit' as const, detail: 'The usage limit was reached.' };

    it('stores the session to resume and keeps the Environment file snapshot', async () => {
      await report({ state: 'running' });

      const failed = await report({
        state: 'failed',
        failure: USAGE_LIMIT,
        workingCopy: WORKING_COPY,
        sessionRef: 'session-7',
      });

      expect(failed).toMatchObject({
        state: 'failed',
        failure: USAGE_LIMIT,
        sessionRef: 'session-7',
        workingCopy: WORKING_COPY,
      });
      // A resumed step still reports text that needs the Run's redaction.
      expect(released).toEqual([]);
    });

    it('ignores a session reference with any other failure', async () => {
      await report({ state: 'running' });

      const failed = await report({
        state: 'failed',
        failure: { code: 'agent_failed', detail: 'x' },
        sessionRef: 'session-7',
      });

      expect(failed.sessionRef).toBeNull();
      expect(released).toEqual([run.id]);
    });
  });
  // Issue #147: a bring-up-to-date request is a Follow-up the worker reports on.
  describe('a bring-up-to-date request (Issue #147)', () => {
    const MERGED = 'b'.repeat(40);
    const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };

    /** The Run delivered, then claimed again by WORKER for a request to bring it up to date. */
    async function requested() {
      await report({ state: 'running' });
      await runs.appendStep(
        run.id,
        WORKER,
        { kind: 'start', result: { outcome: 'done', summary: 'Done.' }, sessionRef: 's-1' },
        { runBranch: 'agent/x-r0b8e5c2d', commits: [], hasUncommittedChanges: false },
        [],
        T0,
      );
      await report({
        state: 'succeeded',
        delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
      });
      await runs.queueFollowUp(run.id, 'Mind the config.', T1, 'bring_up_to_date');
      expect((await runs.claimNext(WORKER, T1))?.id).toBe(run.id);
    }

    const entry = () =>
      runs.runs
        .find((candidate) => candidate.id === run.id)!
        .messages.findLast((message) => message.kind === 'follow_up');

    const START = { baseCommit: 'a'.repeat(40), integrationCommit: MERGED };

    it('records where the merge started, and the merged commit once the part succeeded', async () => {
      await requested();

      await report({ state: 'running', bringUpToDateStarted: START });

      expect(entry()).toMatchObject({
        source: 'bring_up_to_date',
        updateBase: START.baseCommit,
        updateTip: MERGED,
      });
      // Nothing is merged for the page until the part succeeded and delivered.
      expect(entry()).not.toHaveProperty('mergedCommit');
      await report({ state: 'succeeded', delivery: { outcome: 'none' } });
      expect(entry()).toMatchObject({ mergedCommit: MERGED });
    });

    it('records no merged commit for a part that failed', async () => {
      await requested();
      await report({ state: 'running', bringUpToDateStarted: START });

      await report({ state: 'failed', failure: { code: 'agent_failed', detail: 'It broke.' } });

      expect(entry()).not.toHaveProperty('mergedCommit');
    });

    it('records no merge start for a worker that does not hold the Run', async () => {
      await requested();

      await expect(
        report({ workerId: OTHER_WORKER, state: 'running', bringUpToDateStarted: START }),
      ).rejects.toBeInstanceOf(RunNotHeldError);
      expect(entry()).not.toHaveProperty('updateTip');
    });

    it('returns the Run to its earlier result when the branch was already up to date', async () => {
      await requested();

      const restored = await report({ state: 'succeeded', unchanged: true });

      expect(restored).toMatchObject({
        state: 'succeeded',
        claimedBy: null,
        delivery: 'delivered',
        pullRequest: PULL_REQUEST,
      });
      expect(restored.messages.at(-1)).toMatchObject({
        kind: 'part_end',
        state: 'succeeded',
        detail: expect.stringContaining('already has everything dev has'),
      });
      expect(notified).toContain(run.id);
      // The worker's retry of the same report changes nothing.
      expect(await report({ state: 'succeeded', unchanged: true })).toMatchObject({
        state: 'succeeded',
      });
      expect(restored.messages).toHaveLength((await runs.findById(run.id))!.messages.length);
    });

    it('shows why nothing changed when the worker says so, as the conversation entry', async () => {
      await requested();

      const restored = await report({
        state: 'succeeded',
        unchanged: true,
        unchangedDetail: 'The integration branch dev could not be fetched. Nothing was changed.',
      });

      expect(restored).toMatchObject({ state: 'succeeded', delivery: 'delivered' });
      expect(restored.messages.at(-1)).toMatchObject({
        kind: 'part_end',
        detail: 'The integration branch dev could not be fetched. Nothing was changed.',
      });
    });

    it('refuses the report from a worker that does not hold the Run, or for a plain Follow-up', async () => {
      await requested();
      await expect(
        report({ workerId: OTHER_WORKER, state: 'succeeded', unchanged: true }),
      ).rejects.toBeInstanceOf(RunNotHeldError);

      // A Follow-up that is not a bring-up request has no earlier result to return to.
      await runs.finishBringUpToDate(run.id, WORKER, 'x', T1);
      await runs.queueFollowUp(run.id, 'Plain.', T1);
      await runs.claimNext(WORKER, T1);
      await expect(report({ state: 'succeeded', unchanged: true })).rejects.toBeInstanceOf(
        IllegalRunTransitionError,
      );
    });
  });
});
