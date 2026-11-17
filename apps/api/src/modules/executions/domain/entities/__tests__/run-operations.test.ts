import { describe, expect, it } from 'vitest';
import {
  DeliveryNotRetryableError,
  FOLLOW_UP_REFUSALS,
  type FollowUpFacts,
  FollowUpNotAllowedError,
  MAX_ACTIVE_RUNS,
  NO_PULL_REQUEST_STATUS,
  type ResumeFacts,
  Run,
  RunAlreadyFinishedError,
  type RunData,
  RunNotResumableError,
  RunNotWaitingError,
  type RunState,
  RunSlotTakenError,
  USAGE_LIMIT_RESUME_TEXT,
} from '../run.js';
import {
  type ReviewComment,
  ReviewCommentsNotLoadedError,
  ReviewCommentSet,
} from '../../value-objects/review-comments.js';
import { Task } from '../../value-objects/task.js';

// Issue #167: the operator's operations are methods of the Run. Each allowed and each refused
// transition is checked here without a database: the Run decides from its own state and the facts
// passed in, and records what changed for the store to save.
const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const PROJECT_ID = '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T12:30:00.000Z');
const T2 = new Date('2026-11-15T12:45:00.000Z');
const LIMITS = { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 5 };
const WORKING_COPY = { runBranch: 'agent/x-r0b8e5c2d', commits: [], hasUncommittedChanges: false };
const QUESTION = { text: 'Which database?', options: ['PostgreSQL', 'SQLite'] };
const ALL_STATES: RunState[] = [
  'queued',
  'preparing',
  'running',
  'waiting_for_operator',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
];
const FINAL_STATES = ['succeeded', 'failed', 'cancelled', 'timed_out'] as const;

function data(overrides: Partial<RunData> = {}): RunData {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    provider: 'claude_code',
    task: 'Add a health check',
    state: 'queued',
    startCommit: 'a'.repeat(40),
    remoteUrl: 'https://git.example.test/acme/shop.git',
    workingCopy: null,
    integrationBranch: 'dev',
    delivery: null,
    pullRequest: null,
    deliveryRequested: false,
    failingChecks: [],
    createdAt: T0,
    startedAt: null,
    finishedAt: null,
    failure: null,
    claimedBy: null,
    environmentFileSupplied: false,
    environmentFilePath: null,
    limits: LIMITS,
    cancelRequestedAt: null,
    cancellation: null,
    waitingSince: null,
    stepStartedAt: null,
    releasedBy: null,
    sessionRef: null,
    messages: [],
    lastClaimedBy: null,
    stepCount: 0,
    followUpCount: 0,
    followUpQueued: false,
    stepsBeforePart: 0,
    pushedCommit: null,
    workingCopyRemovedAt: null,
    pullRequestStatus: NO_PULL_REQUEST_STATUS,
    lastActivityAt: T0,
    ...overrides,
  };
}

/** A state with the fields that go with it, as storage holds a Run in that state. */
function inState(state: RunState, overrides: Partial<RunData> = {}): Run {
  const byState: Partial<Record<RunState, Partial<RunData>>> = {
    preparing: { claimedBy: WORKER, startedAt: T0 },
    running: { claimedBy: WORKER, startedAt: T0, stepStartedAt: T0 },
    waiting_for_operator: { waitingSince: T0 },
    failed: { failure: { code: 'agent_failed', detail: 'The agent failed.' }, finishedAt: T0 },
    cancelled: {
      cancellation: { by: 'operator', reason: 'Cancelled by the operator.' },
      finishedAt: T0,
    },
    succeeded: { finishedAt: T0 },
    timed_out: { finishedAt: T0 },
  };
  return Run.restore(data({ state, ...byState[state], ...overrides }));
}

const noChanges = (run: Run) => {
  const changes = run.pendingChanges();
  expect(changes.fields).toEqual({});
  expect(changes.messages).toEqual([]);
  expect(changes.discardPreparedFollowUp).toBeUndefined();
  expect(changes.discardReviewComments).toBeUndefined();
};

describe('Run.start and Run.restore', () => {
  const input = {
    id: RUN_ID,
    projectId: PROJECT_ID,
    provider: 'codex' as const,
    task: Task.of('  Add a health check  '),
    startCommit: 'a'.repeat(40),
    remoteUrl: 'https://git.example.test/acme/shop.git',
    integrationBranch: 'dev',
    limits: LIMITS,
    now: T0,
  };

  it('starts a queued Run with the trimmed Task, the limits in force and nothing else set', () => {
    const run = Run.start(input);

    expect(run).toMatchObject({
      id: RUN_ID,
      state: 'queued',
      task: 'Add a health check',
      provider: 'codex',
      limits: LIMITS,
      createdAt: T0,
      lastActivityAt: T0,
      claimedBy: null,
      failure: null,
      messages: [],
      stepCount: 0,
    });
    noChanges(run);
  });

  it('copies the limits, so a later change of the configuration cannot reach the Run', () => {
    const limits = { ...LIMITS };

    const run = Run.start({ ...input, limits });
    limits.maxSteps = 1;

    expect(run.limits.maxSteps).toBe(LIMITS.maxSteps);
  });

  it('refuses a provider it does not know', () => {
    expect(() => Run.start({ ...input, provider: 'gpt' as 'codex' })).toThrow(TypeError);
  });

  it('restores a Run in every state, and refuses a state and failure that disagree', () => {
    for (const state of ALL_STATES) expect(inState(state).state).toBe(state);

    expect(() => Run.restore(data({ state: 'failed', failure: null }))).toThrow(TypeError);
    expect(() =>
      Run.restore(data({ state: 'running', failure: { code: 'unknown', detail: 'x' } })),
    ).toThrow(TypeError);
    expect(() => Run.restore(data({ state: 'cancelled', cancellation: null }))).toThrow(TypeError);
    expect(() =>
      Run.restore(data({ state: 'queued', cancellation: { by: 'system', reason: 'x' } })),
    ).toThrow(TypeError);
    expect(() => Run.restore(data({ state: 'paused' as RunState }))).toThrow(TypeError);
  });
});

describe('Run.answer', () => {
  const waitingWithQuestion = () =>
    inState('waiting_for_operator', {
      sessionRef: 'session-1',
      messages: [{ kind: 'question', question: QUESTION, at: T0 }],
    });

  it('stores the answer after the question and queues the Run again', () => {
    const run = waitingWithQuestion();

    run.answer('PostgreSQL', T1);

    expect(run).toMatchObject({ state: 'queued', waitingSince: null, lastActivityAt: T1 });
    expect(run.messages).toEqual([
      { kind: 'question', question: QUESTION, at: T0 },
      { kind: 'answer', text: 'PostgreSQL', at: T1 },
    ]);
    expect(run.pendingChanges()).toEqual({
      fields: { state: 'queued', waitingSince: null, lastActivityAt: T1 },
      messages: [{ kind: 'answer', text: 'PostgreSQL', at: T1 }],
    });
  });

  it.each(ALL_STATES.filter((state) => state !== 'waiting_for_operator'))(
    'refuses a Run that is %s, naming its state, and changes nothing',
    (state) => {
      const run = inState(state, {
        messages: [{ kind: 'question', question: QUESTION, at: T0 }],
      });

      const error = (() => {
        try {
          run.answer('x', T1);
        } catch (caught) {
          return caught;
        }
      })();

      expect(error).toBeInstanceOf(RunNotWaitingError);
      expect((error as RunNotWaitingError).state).toBe(state);
      noChanges(run);
    },
  );

  it('refuses a waiting Run whose last message is not a question', () => {
    for (const messages of [
      [],
      [
        { kind: 'question' as const, question: QUESTION, at: T0 },
        { kind: 'answer' as const, text: 'PostgreSQL', at: T1 },
      ],
    ]) {
      const run = inState('waiting_for_operator', { messages });

      expect(() => run.answer('x', T2)).toThrow(RunNotWaitingError);
      noChanges(run);
    }
  });

  it('refuses a second answer once the first was taken', () => {
    const run = waitingWithQuestion();
    run.answer('first', T1);

    expect(() => run.answer('second', T2)).toThrow(RunNotWaitingError);
    expect(run.messages.filter((message) => message.kind === 'answer')).toHaveLength(1);
  });
});

describe('Run.cancel', () => {
  it.each(['queued', 'waiting_for_operator'] as const)(
    'cancels a %s Run at once, by the operator',
    (state) => {
      const run = inState(state, { followUpQueued: state === 'queued' });

      run.cancel(T1);

      expect(run).toMatchObject({
        state: 'cancelled',
        cancellation: { by: 'operator', reason: 'Cancelled by the operator.' },
        finishedAt: T1,
        waitingSince: null,
        followUpQueued: false,
        cancelRequestedAt: null,
      });
    },
  );

  it.each(['preparing', 'running'] as const)(
    'records a cancel request on a %s Run and leaves its state to the worker',
    (state) => {
      const run = inState(state);

      run.cancel(T1);

      expect(run).toMatchObject({
        state,
        cancelRequestedAt: T1,
        claimedBy: WORKER,
        cancellation: null,
        finishedAt: null,
      });
      expect(run.pendingChanges().fields).toEqual({ cancelRequestedAt: T1 });
    },
  );

  it('keeps the first request time when the cancel is repeated', () => {
    const run = inState('running', { cancelRequestedAt: T0 });

    run.cancel(T2);

    expect(run.cancelRequestedAt).toEqual(T0);
    noChanges(run);
  });

  it.each(FINAL_STATES)('refuses to cancel a Run that is %s, naming its state', (state) => {
    const run = inState(state);

    const error = (() => {
      try {
        run.cancel(T1);
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(RunAlreadyFinishedError);
    expect((error as RunAlreadyFinishedError).state).toBe(state);
    noChanges(run);
  });

  it('refuses a second cancel of a Run the first one cancelled', () => {
    const run = inState('queued');
    run.cancel(T1);

    expect(() => run.cancel(T2)).toThrow(RunAlreadyFinishedError);
    expect(run.finishedAt).toEqual(T1);
  });
});

describe('Run.requestDeliveryRetry', () => {
  const failedDelivery = (overrides: Partial<RunData> = {}) =>
    inState('failed', {
      failure: { code: 'delivery_failed', detail: 'Pushing was refused.' },
      delivery: 'failed',
      ...overrides,
    });

  it('marks a failed delivery for a retry and keeps the Run failed', () => {
    const run = failedDelivery();

    run.requestDeliveryRetry();

    expect(run).toMatchObject({ state: 'failed', deliveryRequested: true });
    expect(run.pendingChanges().fields).toEqual({ deliveryRequested: true });
  });

  it('changes nothing when the retry is already requested, also while a worker holds it', () => {
    for (const run of [
      failedDelivery({ deliveryRequested: true }),
      failedDelivery({ deliveryRequested: true, claimedBy: WORKER }),
    ]) {
      run.requestDeliveryRetry();

      expect(run.deliveryRequested).toBe(true);
      noChanges(run);
    }
  });

  it('refuses a Run that failed for another reason', () => {
    const run = inState('failed', { failure: { code: 'agent_failed', detail: 'x' } });

    expect(() => run.requestDeliveryRetry()).toThrow(DeliveryNotRetryableError);
    noChanges(run);
  });

  it.each(ALL_STATES.filter((state) => state !== 'failed'))('refuses a Run that is %s', (state) => {
    const run = inState(state);

    expect(() => run.requestDeliveryRetry()).toThrow(DeliveryNotRetryableError);
    noChanges(run);
  });
});

describe('Run.resumeAfterUsageLimit', () => {
  const FREE: ResumeFacts = {
    projectPlaceTaken: false,
    serverPlacesTaken: 0,
    environmentFileSnapshotKept: true,
  };
  const limited = (overrides: Partial<RunData> = {}) =>
    inState('failed', {
      failure: { code: 'usage_limit', detail: 'The usage limit was reached.' },
      sessionRef: 'session-9',
      workingCopy: WORKING_COPY,
      ...overrides,
    });

  it('stores "Continue where you stopped." as the answer and queues the Run again', () => {
    const run = limited({ finishedAt: T0 });

    run.resumeAfterUsageLimit(T1, FREE);

    expect(run).toMatchObject({
      state: 'queued',
      failure: null,
      finishedAt: null,
      lastActivityAt: T1,
      sessionRef: 'session-9',
    });
    expect(run.messages).toEqual([{ kind: 'answer', text: USAGE_LIMIT_RESUME_TEXT, at: T1 }]);
    expect(run.pendingChanges().fields).toEqual({
      state: 'queued',
      failure: null,
      finishedAt: null,
      lastActivityAt: T1,
    });
  });

  it('resumes while a supplied Environment file snapshot is still there', () => {
    const run = limited({ environmentFileSupplied: true });

    run.resumeAfterUsageLimit(T1, FREE);

    expect(run.state).toBe('queued');
  });

  it('refuses a Run whose Environment file snapshot is gone, unless it is in a Follow-up', () => {
    const gone = { ...FREE, environmentFileSnapshotKept: false };
    const first = limited({ environmentFileSupplied: true });

    expect(() => first.resumeAfterUsageLimit(T1, gone)).toThrow(RunNotResumableError);
    noChanges(first);
    // No file was supplied, so none is needed.
    limited().resumeAfterUsageLimit(T1, gone);
    // A Run in a Follow-up works without it already (Issue #141).
    const inFollowUp = limited({ environmentFileSupplied: true, followUpCount: 1 });
    inFollowUp.resumeAfterUsageLimit(T1, gone);
    expect(inFollowUp.state).toBe('queued');
  });

  it.each([
    ['without an agent session', { sessionRef: null }],
    ['without a Working copy', { workingCopy: null }],
    ['with a cancel request', { cancelRequestedAt: T0 }],
    ['for another failure', { failure: { code: 'agent_failed' as const, detail: 'x' } }],
  ])('refuses a Run %s', (_, overrides) => {
    const run = limited(overrides);

    expect(() => run.resumeAfterUsageLimit(T1, FREE)).toThrow(RunNotResumableError);
    noChanges(run);
  });

  it.each(ALL_STATES.filter((state) => state !== 'failed'))('refuses a Run that is %s', (state) => {
    const run = inState(state, { sessionRef: 'session-9', workingCopy: WORKING_COPY });

    expect(() => run.resumeAfterUsageLimit(T1, FREE)).toThrow(RunNotResumableError);
    noChanges(run);
  });

  it('refuses while another Run of the Project holds a place, naming the project', () => {
    const run = limited();

    const error = (() => {
      try {
        run.resumeAfterUsageLimit(T1, { ...FREE, projectPlaceTaken: true });
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(RunSlotTakenError);
    expect((error as RunSlotTakenError).scope).toBe('project');
    noChanges(run);
  });

  it('refuses when the places of the server are taken, but not one fewer', () => {
    const full = limited();
    const error = (() => {
      try {
        full.resumeAfterUsageLimit(T1, { ...FREE, serverPlacesTaken: MAX_ACTIVE_RUNS });
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as RunSlotTakenError).scope).toBe('server');
    noChanges(full);

    const room = limited();
    room.resumeAfterUsageLimit(T1, { ...FREE, serverPlacesTaken: MAX_ACTIVE_RUNS - 1 });
    expect(room.state).toBe('queued');
  });

  it('refuses a Run that is not resumable before it looks at the places', () => {
    const run = limited({ sessionRef: null });

    expect(() => run.resumeAfterUsageLimit(T1, { ...FREE, projectPlaceTaken: true })).toThrow(
      RunNotResumableError,
    );
  });

  it('refuses a second resume once the first was taken', () => {
    const run = limited();
    run.resumeAfterUsageLimit(T1, FREE);

    expect(() => run.resumeAfterUsageLimit(T2, FREE)).toThrow(RunNotResumableError);
    expect(run.messages).toHaveLength(1);
  });
});

describe('Run.followUp', () => {
  const AVAILABLE: FollowUpFacts = { workerAvailable: true, providerAvailable: true };
  const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
  const finished = (state: (typeof FINAL_STATES)[number], overrides: Partial<RunData> = {}) =>
    inState(state, {
      sessionRef: 'session-7',
      workingCopy: WORKING_COPY,
      stepCount: 2,
      pullRequest: PULL_REQUEST,
      delivery: state === 'succeeded' ? 'delivered' : null,
      ...overrides,
    });
  const refusal = (run: Run, facts: FollowUpFacts = AVAILABLE) => {
    try {
      run.followUp('More.', T1, facts);
    } catch (caught) {
      expect(caught).toBeInstanceOf(FollowUpNotAllowedError);
      return (caught as FollowUpNotAllowedError).reason;
    }
    throw new Error('The Follow-up was accepted.');
  };
  const comment = (id: string, author: string): ReviewComment => ({
    id,
    author,
    kind: 'conversation',
    text: `Comment ${id}`,
    createdAt: T0.toISOString(),
  });
  const loaded = (...comments: ReviewComment[]): ReviewCommentSet =>
    ReviewCommentSet.restore({
      scope: 'unresolved',
      comments,
      truncated: false,
      loadedAt: T0,
    });

  it.each(FINAL_STATES)(
    'queues a Follow-up for a %s Run: the earlier part is recorded, the earlier result cleared',
    (state) => {
      const run = finished(state, { finishedAt: T0, stepCount: 2 });
      const ended = run.pendingChanges();
      expect(ended.messages).toEqual([]);

      run.followUp('Also handle HEAD.', T1, AVAILABLE);

      expect(run).toMatchObject({
        state: 'queued',
        lastActivityAt: T1,
        followUpQueued: true,
        followUpCount: 1,
        // A new Run step allowance counts from the steps taken so far.
        stepsBeforePart: 2,
        failure: null,
        finishedAt: null,
        cancellation: null,
        cancelRequestedAt: null,
        delivery: null,
        waitingSince: null,
        stepStartedAt: null,
        // The same pull request is updated.
        pullRequest: PULL_REQUEST,
        sessionRef: 'session-7',
      });
      expect(run.messages).toHaveLength(2);
      expect(run.messages[0]).toMatchObject({ kind: 'part_end', state, at: T1 });
      expect(run.messages[1]).toEqual({ kind: 'follow_up', text: 'Also handle HEAD.', at: T1 });
      expect(run.pendingChanges().discardPreparedFollowUp).toBeUndefined();
      expect(run.pendingChanges().discardReviewComments).toBeUndefined();
    },
  );

  it('records how a failed or cancelled part ended, with its reason', () => {
    const failed = finished('failed', {
      failure: { code: 'agent_failed', detail: 'It broke.' },
    });
    failed.followUp('Retry.', T1, AVAILABLE);
    expect(failed.messages[0]).toEqual({
      kind: 'part_end',
      state: 'failed',
      failureCode: 'agent_failed',
      delivery: null,
      detail: 'It broke.',
      at: T1,
    });

    const cancelled = finished('cancelled');
    cancelled.followUp('Go on.', T1, AVAILABLE);
    expect(cancelled.messages[0]).toMatchObject({
      kind: 'part_end',
      state: 'cancelled',
      detail: 'Cancelled by the operator.',
    });
  });

  it('records the Follow-up on top of the earlier conversation', () => {
    const run = finished('succeeded', {
      messages: [{ kind: 'question', question: QUESTION, at: T0 }],
    });

    run.followUp('More.', T1, AVAILABLE);

    expect(run.messages.map((message) => message.kind)).toEqual([
      'question',
      'part_end',
      'follow_up',
    ]);
  });

  it('refuses a Follow-up while one is queued, and a second right after the first', () => {
    expect(refusal(finished('succeeded', { followUpQueued: true }))).toBe('follow_up_queued');
    const run = finished('succeeded');
    run.followUp('First.', T1, AVAILABLE);
    expect(refusal(run)).toBe('follow_up_queued');
    expect(run.messages.filter((message) => message.kind === 'follow_up')).toHaveLength(1);
  });

  it.each(['queued', 'preparing', 'running', 'waiting_for_operator'] as const)(
    'refuses a Run that is %s as not finished',
    (state) => {
      expect(refusal(inState(state, { sessionRef: 'session-7', workingCopy: WORKING_COPY }))).toBe(
        'not_finished',
      );
    },
  );

  it('refuses a finished Run a worker holds or whose delivery retry is requested', () => {
    expect(refusal(finished('succeeded', { claimedBy: WORKER }))).toBe('not_finished');
    expect(
      refusal(
        finished('failed', {
          failure: { code: 'delivery_failed', detail: 'x' },
          deliveryRequested: true,
        }),
      ),
    ).toBe('not_finished');
  });

  it.each([
    ['merged', 'pull_request_merged'],
    ['closed', 'pull_request_closed'],
    ['missing', 'pull_request_missing'],
  ] as const)('refuses a Run whose pull request is %s', (state, reason) => {
    const run = finished('succeeded', {
      pullRequestStatus: { ...NO_PULL_REQUEST_STATUS, state },
    });

    expect(refusal(run)).toBe(reason);
  });

  it.each(['draft', 'open'] as const)('accepts a Run whose pull request is %s', (state) => {
    const run = finished('succeeded', {
      pullRequestStatus: { ...NO_PULL_REQUEST_STATUS, state },
    });

    run.followUp('More.', T1, AVAILABLE);

    expect(run.state).toBe('queued');
  });

  it('refuses a Run without an agent session or without a kept Working copy', () => {
    expect(refusal(finished('succeeded', { sessionRef: null }))).toBe('no_session');
    expect(refusal(finished('succeeded', { workingCopy: null }))).toBe('working_copy_removed');
    expect(refusal(finished('succeeded', { workingCopyRemovedAt: T0 }))).toBe(
      'working_copy_removed',
    );
  });

  it('refuses a Run that took as many Run steps as its total, but not one fewer', () => {
    expect(refusal(finished('succeeded', { stepCount: LIMITS.maxTotalSteps }))).toBe(
      'step_total_reached',
    );
    const run = finished('succeeded', { stepCount: LIMITS.maxTotalSteps - 1 });
    run.followUp('More.', T1, AVAILABLE);
    expect(run.stepsBeforePart).toBe(LIMITS.maxTotalSteps - 1);
  });

  it('refuses when the worker holding the Working copy or the Provider is unavailable', () => {
    const run = () => finished('succeeded');

    expect(refusal(run(), { workerAvailable: false, providerAvailable: true })).toBe(
      'worker_unavailable',
    );
    expect(refusal(run(), { workerAvailable: true, providerAvailable: false })).toBe(
      'provider_unavailable',
    );
    expect(refusal(run(), { workerAvailable: false, providerAvailable: false })).toBe(
      'worker_unavailable',
    );
  });

  it('changes nothing when it refuses', () => {
    for (const run of [
      finished('succeeded', { followUpQueued: true }),
      finished('succeeded', { sessionRef: null }),
      finished('succeeded', { stepCount: LIMITS.maxTotalSteps }),
      inState('running'),
    ]) {
      expect(() => run.followUp('x', T1, AVAILABLE)).toThrow(FollowUpNotAllowedError);
      noChanges(run);
    }
    const unavailable = finished('succeeded');
    expect(() =>
      unavailable.followUp('x', T1, { workerAvailable: false, providerAvailable: true }),
    ).toThrow(FollowUpNotAllowedError);
    noChanges(unavailable);
  });

  it('covers every refusal reason the Follow-up knows', () => {
    const seen = new Set<string>([
      refusal(finished('succeeded', { followUpQueued: true })),
      refusal(inState('running')),
      refusal(
        finished('succeeded', {
          pullRequestStatus: { ...NO_PULL_REQUEST_STATUS, state: 'merged' },
        }),
      ),
      refusal(
        finished('succeeded', {
          pullRequestStatus: { ...NO_PULL_REQUEST_STATUS, state: 'closed' },
        }),
      ),
      refusal(
        finished('succeeded', {
          pullRequestStatus: { ...NO_PULL_REQUEST_STATUS, state: 'missing' },
        }),
      ),
      refusal(finished('succeeded', { workingCopyRemovedAt: T0 })),
      refusal(finished('succeeded', { sessionRef: null })),
      refusal(finished('succeeded', { stepCount: LIMITS.maxTotalSteps })),
      refusal(finished('succeeded'), { workerAvailable: true, providerAvailable: false }),
      refusal(finished('succeeded'), { workerAvailable: false, providerAvailable: true }),
    ]);

    expect([...seen].sort()).toEqual([...FOLLOW_UP_REFUSALS].sort());
  });

  describe('prepared from a source', () => {
    it.each(['pull_request_checks', 'bring_up_to_date'] as const)(
      'says it came from %s and removes the prepared Follow-up of that source',
      (source) => {
        const run = finished('succeeded');

        run.followUp(source === 'bring_up_to_date' ? '' : 'Fix the checks.', T1, AVAILABLE, source);

        expect(run.messages[1]).toMatchObject({ kind: 'follow_up', source });
        expect(run.pendingChanges().discardPreparedFollowUp).toBe(source);
        expect(run.pendingChanges().discardReviewComments).toBeUndefined();
      },
    );

    it('sends the selected Review comments, recording how many and whose, and removes the set', () => {
      const run = finished('succeeded');
      const set = loaded(
        comment('conversation-1', 'octocat'),
        comment('inline-2', 'someone'),
        comment('review-3', 'octocat'),
      );

      run.followUp(
        'Fix these.',
        T1,
        AVAILABLE,
        {
          source: 'review_comments',
          commentIds: ['conversation-1', 'review-3'],
        },
        set,
      );

      expect(run.messages[1]).toEqual({
        kind: 'follow_up',
        text: 'Fix these.',
        at: T1,
        source: 'review_comments',
        sourceComments: { count: 2, authors: ['octocat'] },
      });
      expect(run.pendingChanges().discardReviewComments).toBe(true);
      expect(run.pendingChanges().discardPreparedFollowUp).toBeUndefined();
    });

    it('refuses selected comments that are not all in the loaded set, and changes nothing', () => {
      const run = finished('succeeded');
      const origin = {
        source: 'review_comments' as const,
        commentIds: ['conversation-1', 'conversation-9'],
      };

      expect(() =>
        run.followUp('x', T1, AVAILABLE, origin, loaded(comment('conversation-1', 'a'))),
      ).toThrow(ReviewCommentsNotLoadedError);
      expect(() => run.followUp('x', T1, AVAILABLE, origin, null)).toThrow(
        ReviewCommentsNotLoadedError,
      );
      expect(() =>
        run.followUp('x', T1, AVAILABLE, { source: 'review_comments', commentIds: [] }, loaded()),
      ).toThrow(ReviewCommentsNotLoadedError);
      expect(() =>
        run.followUp(
          'x',
          T1,
          AVAILABLE,
          { source: 'review_comments', commentIds: ['conversation-1', 'conversation-1'] },
          loaded(comment('conversation-1', 'a')),
        ),
      ).toThrow(ReviewCommentsNotLoadedError);
      noChanges(run);
      expect(run.state).toBe('succeeded');
    });

    it('checks the Run before the comments: a Run that cannot take it is refused as such', () => {
      const run = inState('running');

      expect(() =>
        run.followUp('x', T1, AVAILABLE, { source: 'review_comments', commentIds: ['nope'] }, null),
      ).toThrow(FollowUpNotAllowedError);
    });
  });
});
