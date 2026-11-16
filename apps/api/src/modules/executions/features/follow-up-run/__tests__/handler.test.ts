import { beforeEach, describe, expect, it } from 'vitest';
import { FollowUpNotAllowedError, type Run, type RunState } from '../../../domain/entities/run.js';
import { InMemoryRunLookupRepository } from '../../../domain/repositories/__tests__/in-memory-run-lookup-repository.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { RunNotFoundError } from '../../../domain/repositories/run-repository.js';
import type { RecordedWorkerStatus } from '../../../domain/services/provider-availability.js';
import type { WorkerStatusStore } from '../../../ports/worker-status-store.js';
import { runView } from '../../../domain/services/follow-up-context.js';
import type { RetentionPolicy } from '../../../ports/retention-policy.js';
import { FollowUpRunHandler, ReviewCommentsNotLoadedError } from '../handler.js';
import type { ReviewComment } from '../../../domain/entities/review-comments.js';

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

// Issue #141: the operator sends a Follow-up to a finished Run.
const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER_PROJECT = '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const UNKNOWN_RUN = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const T0 = new Date('2026-11-16T12:00:00.000Z');
const T1 = new Date('2026-11-16T12:30:00.000Z');
const LEASE = { seconds: 60 };
const RETENTION: RetentionPolicy = {
  days: 7,
  maxPerProject: 10,
  openPullRequestIdleDays: 30,
  hoursAfterPullRequestEnd: 24,
};
const DAY = 24 * 60 * 60_000;
const WORKING_COPY = {
  runBranch: 'agent/x-r0b8e5c2d',
  commits: [{ id: 'a'.repeat(40), subject: 'First' }],
  hasUncommittedChanges: false,
};
const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
const newRun = (projectId = PROJECT, maxTotalSteps = 50) => ({
  projectId,
  provider: 'claude_code' as const,
  task: 'Add a health check',
  startCommit: 'a',
  remoteUrl: 'https://git.example.test/a.git',
  limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps },
  integrationBranch: 'dev',
});

describe('FollowUpRunHandler', () => {
  let runs: InMemoryRunRepository;
  let workers: InMemoryWorkerStatusStore;
  let lookups: InMemoryRunLookupRepository;
  let handler: FollowUpRunHandler;

  /** The worker reports itself connected with both providers on, at `at`. */
  function connect(workerId = WORKER, at = T1, providers = { claude_code: true, codex: true }) {
    workers.record({ workerId, runner: 'fake', providers, reportedAt: at });
  }

  /** A Run WORKER carried to `end` after `steps` done steps, delivering its pull request. */
  async function finished(end: RunState = 'succeeded', steps = 1, projectId = PROJECT) {
    const added = await runs.add(newRun(projectId));
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
      ...(end === 'cancelled' ? { cancellation: { by: 'operator' as const, reason: 'x' } } : {}),
      cancelRequested: end === 'cancelled',
      now: T0,
    });
    return (await runs.findById(added.id))!;
  }

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    workers = new InMemoryWorkerStatusStore();
    lookups = new InMemoryRunLookupRepository(runs);
    handler = new FollowUpRunHandler(
      runs,
      { now: () => T1 },
      workers,
      LEASE,
      lookups,
      RETENTION,
      lookups,
    );
    connect();
  });

  // Issue #145: a Follow-up prepared from failing checks, as the operator left it.
  describe('a Follow-up prepared from failing checks', () => {
    const draft = {
      source: 'pull_request_checks' as const,
      text: 'Prepared text.',
      items: [{ name: 'unit tests', url: 'https://ci.test/1', logAvailable: true, section: 'x' }],
    };

    it('is stored as given, marked with its source, and removes the prepared draft', async () => {
      const run = await finished();
      runs.prepared.set(run.id, draft);

      const { run: queued } = await handler.execute(
        run.id,
        'Prepared text, edited by the operator.',
        'pull_request_checks',
      );

      expect(queued.messages.at(-1)).toEqual({
        kind: 'follow_up',
        text: 'Prepared text, edited by the operator.',
        at: T1,
        source: 'pull_request_checks',
      });
      expect(runs.prepared.has(run.id)).toBe(false);
    });

    it('keeps the prepared draft when the Follow-up is refused', async () => {
      const run = await finished();
      await handler.execute(run.id, 'A first Follow-up.');
      runs.prepared.set(run.id, draft);

      await expect(handler.execute(run.id, 'Text.', 'pull_request_checks')).rejects.toBeInstanceOf(
        FollowUpNotAllowedError,
      );

      expect(runs.prepared.has(run.id)).toBe(true);
    });

    it('has no source when the operator wrote it from scratch', async () => {
      const run = await finished();
      runs.prepared.set(run.id, draft);

      const { run: queued } = await handler.execute(run.id, 'Written from scratch.');

      expect(queued.messages.at(-1)).not.toHaveProperty('source');
      // A Follow-up of its own does not touch a draft the operator is still reviewing.
      expect(runs.prepared.has(run.id)).toBe(true);
    });
  });

  // Issue #146: a Follow-up prepared from the pull request's Review comments.
  describe('a Follow-up prepared from review comments', () => {
    const comment = (id: string, author: string): ReviewComment => ({
      id,
      author,
      kind: 'conversation',
      text: 'Please add a test.',
      createdAt: '2026-11-16T10:00:00.000Z',
    });
    const load = (runId: string) =>
      runs.reviewSets.set(runId, {
        scope: 'unresolved',
        comments: [
          comment('conversation-1', 'octocat'),
          comment('conversation-2', 'octocat'),
          comment('conversation-3', 'stranger'),
        ],
        truncated: false,
        loadedAt: T0,
      });

    it('records the source, how many comments and their authors, and removes the loaded set', async () => {
      const run = await finished();
      load(run.id);

      const { run: queued } = await handler.execute(
        run.id,
        'Add the test the reviewer asked for.',
        'review_comments',
        ['conversation-1', 'conversation-3'],
      );

      expect(queued.messages.at(-1)).toEqual({
        kind: 'follow_up',
        text: 'Add the test the reviewer asked for.',
        at: T1,
        source: 'review_comments',
        sourceComments: { count: 2, authors: ['octocat', 'stranger'] },
      });
      expect(runs.reviewSets.has(run.id)).toBe(false);
    });

    it('refuses ids outside the loaded set, repeated ids and a set that was never loaded', async () => {
      const run = await finished();
      await expect(
        handler.execute(run.id, 'x', 'review_comments', ['conversation-1']),
      ).rejects.toBeInstanceOf(ReviewCommentsNotLoadedError);
      load(run.id);

      for (const ids of [['conversation-9'], ['conversation-1', 'conversation-1'], []]) {
        await expect(handler.execute(run.id, 'x', 'review_comments', ids)).rejects.toBeInstanceOf(
          ReviewCommentsNotLoadedError,
        );
      }

      // Nothing was queued, and the set is still there.
      expect((await runs.findById(run.id))?.followUpQueued).toBe(false);
      expect(runs.reviewSets.has(run.id)).toBe(true);
    });

    it('keeps the loaded set when the Follow-up is refused', async () => {
      const run = await finished();
      await handler.execute(run.id, 'A first Follow-up.');
      load(run.id);

      await expect(
        handler.execute(run.id, 'x', 'review_comments', ['conversation-1']),
      ).rejects.toBeInstanceOf(FollowUpNotAllowedError);

      expect(runs.reviewSets.has(run.id)).toBe(true);
    });

    it('leaves a loaded set alone when the operator writes a Follow-up from scratch', async () => {
      const run = await finished();
      load(run.id);

      const { run: queued } = await handler.execute(run.id, 'Written from scratch.');

      expect(queued.messages.at(-1)).not.toHaveProperty('source');
      expect(runs.reviewSets.has(run.id)).toBe(true);
    });
  });

  it.each(['succeeded', 'failed', 'timed_out', 'cancelled'] as const)(
    'queues a %s Run for its agent worker, with the Follow-up as its latest message',
    async (end) => {
      const run = await finished(end);

      const { run: queued, followUp } = await handler.execute(run.id, 'Also handle empty lists.');

      expect(queued).toMatchObject({
        state: 'queued',
        followUpQueued: true,
        followUpCount: 1,
        stepsBeforePart: 1,
        failure: null,
        finishedAt: null,
        cancellation: null,
        cancelRequestedAt: null,
        delivery: null,
        sessionRef: 'session-1',
      });
      expect(queued.messages.at(-1)).toEqual({
        kind: 'follow_up',
        text: 'Also handle empty lists.',
        at: T1,
      });
      expect(followUp).toEqual({ allowed: false, reason: 'follow_up_queued' });
    },
  );

  it("keeps the Run's pull request: the same one is updated", async () => {
    const run = await finished('succeeded');

    const { run: queued } = await handler.execute(run.id, 'Rename it.');

    expect(queued.pullRequest).toEqual(PULL_REQUEST);
  });

  it('refuses a second submission while one is queued, and a Run that is not finished', async () => {
    const run = await finished('succeeded');
    await handler.execute(run.id, 'First.');

    await expect(handler.execute(run.id, 'Second.')).rejects.toEqual(
      new FollowUpNotAllowedError('follow_up_queued'),
    );
    await runs.claimNext(WORKER, T1);
    await expect(handler.execute(run.id, 'Third.')).rejects.toEqual(
      new FollowUpNotAllowedError('not_finished'),
    );
    expect(
      (await runs.findById(run.id))!.messages.filter((m) => m.kind === 'follow_up'),
    ).toHaveLength(1);
  });

  it('refuses a Run whose Working copy was removed, or that has no session', async () => {
    const removed = await finished('succeeded');
    await runs.markWorkingCopiesRemoved(WORKER, [removed.id], T1);
    await expect(handler.execute(removed.id, 'x')).rejects.toEqual(
      new FollowUpNotAllowedError('working_copy_removed'),
    );

    const failedAtStart: Run = await runs.add(newRun(OTHER_PROJECT));
    await runs.claimNext(WORKER, T0);
    await runs.transitionClaimed({
      runId: failedAtStart.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'failed',
      failure: { code: 'preparation_failed', detail: 'x' },
      cancelRequested: false,
      now: T0,
    });
    await expect(handler.execute(failedAtStart.id, 'x')).rejects.toEqual(
      new FollowUpNotAllowedError('no_session'),
    );
  });

  it('refuses a Run that has used its Run step total', async () => {
    const added = await runs.add({ ...newRun(), limits: { ...newRun().limits, maxTotalSteps: 2 } });
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
    for (let i = 0; i < 2; i++) {
      await runs.appendStep(
        added.id,
        WORKER,
        { kind: 'start', result: {}, sessionRef: 'session-1' },
        WORKING_COPY,
        [],
        T0,
      );
    }
    await runs.transitionClaimed({
      runId: added.id,
      workerId: WORKER,
      from: 'running',
      to: 'succeeded',
      failure: null,
      delivery: { outcome: 'none' },
      cancelRequested: false,
      now: T0,
    });

    await expect(handler.execute(added.id, 'x')).rejects.toEqual(
      new FollowUpNotAllowedError('step_total_reached'),
    );
  });

  it('refuses while the agent worker holding the Working copy is gone, or the Provider is off', async () => {
    const run = await finished('succeeded');
    workers = new InMemoryWorkerStatusStore();
    handler = new FollowUpRunHandler(
      runs,
      { now: () => T1 },
      workers,
      LEASE,
      lookups,
      RETENTION,
      lookups,
    );
    connect(OTHER_WORKER);
    await expect(handler.execute(run.id, 'x')).rejects.toEqual(
      new FollowUpNotAllowedError('worker_unavailable'),
    );

    connect(WORKER, T1, { claude_code: false, codex: true });
    await expect(handler.execute(run.id, 'x')).rejects.toEqual(
      new FollowUpNotAllowedError('provider_unavailable'),
    );
  });

  // Issue #142: the Run's pull request, as last read.
  const readAs = (run: Run, state: 'draft' | 'open' | 'merged' | 'closed' | 'missing' | null) => {
    const stored = runs.runs.find((candidate) => candidate.id === run.id)!;
    stored.pullRequestStatus = {
      ...stored.pullRequestStatus,
      state,
      refreshedAt: state === null ? null : T0,
    };
  };

  it.each([
    ['merged', 'pull_request_merged'],
    ['closed', 'pull_request_closed'],
    ['missing', 'pull_request_missing'],
  ] as const)('refuses a Follow-up to a Run whose pull request is %s', async (state, reason) => {
    const run = await finished('succeeded');
    readAs(run, state);

    await expect(handler.execute(run.id, 'Go on.')).rejects.toEqual(
      new FollowUpNotAllowedError(reason),
    );
    expect((await runs.findById(run.id))?.state).toBe('succeeded');
  });

  it.each(['draft', 'open', null] as const)(
    'takes a Follow-up when the pull request is %s (unknown included)',
    async (state) => {
      const run = await finished('succeeded');
      readAs(run, state);

      const { run: queued } = await handler.execute(run.id, 'Go on.');

      expect(queued.state).toBe('queued');
    },
  );

  it('takes a Follow-up again once the next refresh finds the pull request reopened', async () => {
    const run = await finished('succeeded');
    readAs(run, 'closed');
    await expect(handler.execute(run.id, 'Go on.')).rejects.toBeInstanceOf(FollowUpNotAllowedError);

    readAs(run, 'open');

    expect((await handler.execute(run.id, 'Go on.')).run.state).toBe('queued');
  });

  it('asks for the pull request state to be read again when it accepts a Follow-up', async () => {
    const run = await finished('succeeded');

    const { run: queued } = await handler.execute(run.id, 'Go on.');

    expect(lookups.lookups).toHaveLength(1);
    expect(lookups.lookups[0]).toMatchObject({ runId: run.id, kind: 'pull_request_state' });
    expect(queued.pullRequestStatus.refreshRequestedAt).toEqual(T1);
  });

  it('still accepts the Follow-up when asking for the pull request state fails (review S6 of #152)', async () => {
    const run = await finished('succeeded');
    lookups.request = () => Promise.reject(new Error('The database is busy'));

    const { run: queued } = await handler.execute(run.id, 'Go on.');

    expect(queued.state).toBe('queued');
    expect(queued.followUpQueued).toBe(true);
  });

  it('answers not found for an unknown Run or an id that is not a UUID', async () => {
    await expect(handler.execute(UNKNOWN_RUN, 'x')).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(handler.execute('nope', 'x')).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it('waits in the queue without holding a place: another Run of the project starts first', async () => {
    const run = await finished('succeeded');
    const other = await runs.add(newRun());
    const started = await runs.claimNext(OTHER_WORKER, T1);
    expect(started?.id).toBe(other.id);

    await handler.execute(run.id, 'Go on.');

    // The project is busy: the Follow-up waits, then its own worker claims it once it is free.
    expect(await runs.claimNext(WORKER, T1)).toBeNull();
    await runs.transitionClaimed({
      runId: other.id,
      workerId: OTHER_WORKER,
      from: 'preparing',
      to: 'failed',
      failure: { code: 'preparation_failed', detail: 'x' },
      cancelRequested: false,
      now: T1,
    });
    expect(await runs.claimNext(OTHER_WORKER, T1)).toBeNull();
    expect(await runs.claimNext(WORKER, T1)).toMatchObject({
      id: run.id,
      state: 'preparing',
      followUpQueued: false,
    });
  });

  it('gives the Follow-up its own Run step allowance', async () => {
    const run = await finished('succeeded', 10);
    await handler.execute(run.id, 'Go on.');
    await runs.claimNext(WORKER, T1);
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      cancelRequested: false,
      now: T1,
    });

    for (let i = 0; i < 10; i++) {
      expect(
        await runs.appendStep(run.id, WORKER, { kind: 'resume', result: {} }, WORKING_COPY, [], T1),
      ).toMatchObject({ status: 'stored' });
    }
    expect(
      await runs.appendStep(run.id, WORKER, { kind: 'resume', result: {} }, WORKING_COPY, [], T1),
    ).toEqual({ status: 'step_limit' });
    expect((await runs.findById(run.id))!.failure).toEqual({
      code: 'step_limit',
      detail: 'The Follow-up reached its limit of 10 run steps; no further step was started.',
    });
  });
  // Issue #143: the Run page says until when the Run stays open to Follow-ups.
  describe('until when a Run is open to Follow-ups (Issue #143)', () => {
    const view = (run: Run, at = T1) => runView(run, workers, at, LEASE.seconds, RETENTION);

    it('says the Run with a pull request is open until 30 days after its last activity', async () => {
      const run = await finished('succeeded');

      expect(view(run).followUp).toEqual({
        allowed: true,
        openUntil: new Date(run.lastActivityAt.getTime() + 30 * DAY),
      });
    });

    it('moves the date when the Run has activity: a Run step, an Answer, a Follow-up', async () => {
      const run = await finished('succeeded');
      const before = view(run).followUp.openUntil!;

      await runs.queueFollowUp(run.id, 'More.', new Date(T1.getTime() + 5 * DAY));
      const queued = (await runs.findById(run.id))!;

      expect(queued.lastActivityAt).toEqual(new Date(T1.getTime() + 5 * DAY));
      expect(queued.lastActivityAt.getTime()).toBeGreaterThan(run.lastActivityAt.getTime());
      expect(new Date(queued.lastActivityAt.getTime() + 30 * DAY).getTime()).toBeGreaterThan(
        before.getTime(),
      );
    });

    it('counts a Run without a pull request seven days from when it finished', async () => {
      const run = await finished('failed');

      expect(view(run).followUp).toEqual({
        allowed: true,
        openUntil: new Date(run.finishedAt!.getTime() + 7 * DAY),
      });
    });

    it('says removal is pending instead of a date that has passed', async () => {
      const run = await finished('succeeded');
      const later = new Date(run.lastActivityAt.getTime() + 31 * DAY);
      connect(WORKER, later);

      const { followUp } = view(run, later);

      expect(followUp).toEqual({ allowed: true, removalPending: true });
    });

    it('says removal is pending for a Run the per-Project limit removes', async () => {
      const run = await finished('failed');

      const { followUp } = runView(run, workers, T1, LEASE.seconds, RETENTION, true);

      expect(followUp).toEqual({ allowed: true, removalPending: true });
    });

    it('also gives the date while only the worker or the Provider is missing', async () => {
      const run = await finished('succeeded');
      workers = new InMemoryWorkerStatusStore();
      connect(OTHER_WORKER);

      expect(view(run).followUp).toMatchObject({
        allowed: false,
        reason: 'worker_unavailable',
        openUntil: expect.any(Date),
      });
    });

    it('gives no date once the pull request ended, the Working copy is gone, or the Run is not finished', async () => {
      const merged = await finished('succeeded');
      runs.runs.find((run) => run.id === merged.id)!.pullRequestStatus = {
        ...merged.pullRequestStatus,
        state: 'merged',
        endedAt: T0,
      };
      const removed = await finished('succeeded');
      runs.runs.find((run) => run.id === removed.id)!.workingCopyRemovedAt = T0;
      const queued = await runs.add(newRun(OTHER_PROJECT));

      for (const run of [merged, removed, queued]) {
        const current = (await runs.findById(run.id))!;
        const { followUp } = view(current);
        expect(followUp.allowed).toBe(false);
        expect(followUp).not.toHaveProperty('openUntil');
      }
    });
  });
});
