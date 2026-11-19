import { describe, expect, it } from 'vitest';
import {
  IllegalRunTransitionError,
  RunNotHeldError,
  StepOutOfOrderError,
} from '../../errors/run-errors.js';
import { Run } from '../run.js';
import { RunPullRequestStatus } from '../../value-objects/run-pull-request-status.js';
import { RunCancellation } from '../../value-objects/run-cancellation.js';
import { type RestoreData } from '../../../../../__tests__/restore-data.js';
import { type RunState } from '../../value-objects/run-state.js';
import { type RunStateReport } from '../run-report-facts.js';

const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const PROJECT_ID = '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T12:30:00.000Z');
const LIMITS = { stepMinutes: 60, maxSteps: 2, waitingDays: 14, maxTotalSteps: 5 };
const WORKING_COPY = {
  runBranch: 'agent/x-r0b8e5c2d',
  commits: [{ id: 'c'.repeat(40), subject: 'Add GET /health' }],
  hasUncommittedChanges: false,
};
const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
const DELIVERY_FAILED = { code: 'delivery_failed', detail: 'Pushing was refused.' } as const;

function data(overrides: Partial<RestoreData<typeof Run>> = {}): RestoreData<typeof Run> {
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
    heartbeatAt: null,
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
    pullRequestStatus: RunPullRequestStatus.none().toStored(),
    lastActivityAt: T0,
    ...overrides,
  };
}

function inState(state: RunState, overrides: Partial<RestoreData<typeof Run>> = {}): Run {
  const byState: Partial<Record<RunState, Partial<RestoreData<typeof Run>>>> = {
    preparing: { claimedBy: WORKER, lastClaimedBy: WORKER, heartbeatAt: T0, startedAt: T0 },
    running: {
      claimedBy: WORKER,
      lastClaimedBy: WORKER,
      heartbeatAt: T0,
      startedAt: T0,
      stepStartedAt: T0,
    },
    waiting_for_operator: { waitingSince: T0, releasedBy: WORKER, lastClaimedBy: WORKER },
    failed: {
      failure: { code: 'agent_failed', detail: 'The agent failed.' },
      finishedAt: T0,
      releasedBy: WORKER,
      lastClaimedBy: WORKER,
    },
    cancelled: {
      cancellation: { by: 'operator', reason: 'Cancelled by the operator.' },
      finishedAt: T0,
    },
    succeeded: { finishedAt: T0, releasedBy: WORKER, lastClaimedBy: WORKER },
    timed_out: { finishedAt: T0 },
  };
  return Run.restore(data({ state, ...byState[state], ...overrides }));
}

const report = (overrides: Partial<RunStateReport> = {}): RunStateReport => ({
  state: 'running',
  failure: null,
  ...overrides,
});

const retrying = (overrides: Partial<RestoreData<typeof Run>> = {}) =>
  inState('failed', {
    failure: DELIVERY_FAILED,
    delivery: 'failed',
    deliveryRequested: true,
    claimedBy: WORKER,
    heartbeatAt: T0,
    releasedBy: null,
    workingCopy: WORKING_COPY,
    ...overrides,
  });

const BRING_UP: RestoreData<typeof Run>['messages'] = [
  {
    kind: 'part_end',
    state: 'succeeded',
    failureCode: null,
    delivery: 'delivered',
    detail: '',
    at: T0,
  },
  { kind: 'follow_up', text: '', at: T0, source: 'bring_up_to_date' },
];

describe('a state the agent worker reports', () => {
  it('moves a preparing Run it holds to running, started the step now, still held', () => {
    const run = inState('preparing');

    expect(run.reportState(WORKER, report(), T1)).toBe(true);

    expect(run).toMatchObject({
      lifecycle: { state: 'running', failure: null },
      claim: { claimedBy: WORKER, heartbeatAt: T1, releasedBy: null },
      progress: { stepStartedAt: T1 },
    });
  });

  it('releases a running Run that waits for the operator, waiting since now', () => {
    const run = inState('running');

    run.reportState(WORKER, report({ state: 'waiting_for_operator' }), T1);

    expect(run).toMatchObject({
      lifecycle: { state: 'waiting_for_operator' },
      claim: { claimedBy: null, heartbeatAt: null, releasedBy: WORKER },
      progress: { waitingSince: T1 },
    });
  });

  it('finishes a succeeded Run with its delivery, released and finished now', () => {
    const run = inState('running');

    run.reportState(
      WORKER,
      report({
        state: 'succeeded',
        delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST, pushedCommit: 'f'.repeat(40) },
      }),
      T1,
    );

    expect(run).toMatchObject({
      lifecycle: { state: 'succeeded', finishedAt: T1 },
      claim: { claimedBy: null, heartbeatAt: null, releasedBy: WORKER },
      delivery: { state: 'delivered', pullRequest: PULL_REQUEST, pushedCommit: 'f'.repeat(40) },
    });
  });

  it('records the failure, the Working copy and the session of a Run stopped at the usage limit', () => {
    const run = inState('running');

    run.reportState(
      WORKER,
      report({
        state: 'failed',
        failure: { code: 'usage_limit', detail: 'The usage limit was reached.' },
        workingCopy: WORKING_COPY,
        sessionRef: 'session-9',
      }),
      T1,
    );

    expect(run).toMatchObject({
      workingCopy: WORKING_COPY,
      lifecycle: {
        state: 'failed',
        failure: { code: 'usage_limit', detail: 'The usage limit was reached.' },
        finishedAt: T1,
      },
      claim: { sessionRef: 'session-9' },
    });
  });

  it('records a failed delivery with the commit it pushed before it failed', () => {
    const run = inState('running');

    run.reportState(
      WORKER,
      report({ state: 'failed', failure: DELIVERY_FAILED, pushedCommit: 'e'.repeat(40) }),
      T1,
    );

    expect(run).toMatchObject({
      lifecycle: { state: 'failed' },
      delivery: { state: 'failed', pushedCommit: 'e'.repeat(40) },
    });
  });

  it('keeps the Working copy only for a Run that did not succeed or wait', () => {
    const waiting = inState('running');
    waiting.reportState(
      WORKER,
      report({ state: 'waiting_for_operator', workingCopy: WORKING_COPY }),
      T1,
    );
    const timedOut = inState('running');
    timedOut.reportState(WORKER, report({ state: 'timed_out', workingCopy: WORKING_COPY }), T1);

    expect(waiting.workingCopy).toBeNull();
    expect(timedOut.workingCopy).toEqual(WORKING_COPY);
  });

  it('confirms the stop of a Run the operator asked to cancel', () => {
    const run = inState('running', { cancelRequestedAt: T0 });

    run.reportState(WORKER, report({ state: 'cancelled' }), T1);

    expect(run).toMatchObject({
      lifecycle: { state: 'cancelled', cancellation: RunCancellation.OPERATOR, finishedAt: T1 },
      claim: { claimedBy: null },
    });
  });

  it('ends a Run as cancelled when its step ended waiting after the operator asked to cancel', () => {
    const run = inState('running', { cancelRequestedAt: T0 });

    run.reportState(WORKER, report({ state: 'waiting_for_operator' }), T1);

    expect(run).toMatchObject({
      lifecycle: { state: 'cancelled' },
      progress: { waitingSince: null },
    });
  });

  it('keeps the delivery of a Run cancelled during it, and says whether the branch was pushed', () => {
    const run = inState('running', { cancelRequestedAt: T0 });

    run.reportState(
      WORKER,
      report({ state: 'cancelled', delivery: { outcome: 'none', branchPushed: true } }),
      T1,
    );

    expect(run).toMatchObject({
      lifecycle: { state: 'cancelled', cancellation: RunCancellation.OPERATOR_BRANCH_PUSHED },
      delivery: { state: 'none' },
    });
  });

  it('keeps the delivery of a succeeded report while a cancel is pending', () => {
    const run = inState('running', { cancelRequestedAt: T0 });

    run.reportState(WORKER, report({ state: 'succeeded', delivery: { outcome: 'none' } }), T1);

    expect(run).toMatchObject({ lifecycle: { state: 'succeeded' }, delivery: { state: 'none' } });
  });

  it('refuses a cancelled report when the operator asked for nothing', () => {
    const run = inState('running');

    expect(() => run.reportState(WORKER, report({ state: 'cancelled' }), T1)).toThrow(
      IllegalRunTransitionError,
    );
    expect(run.lifecycle.state).toBe('running');
    expect(run.pendingChanges().fields).toEqual({});
  });

  it('refuses a transition the state machine does not allow', () => {
    const run = inState('preparing');

    expect(() => run.reportState(WORKER, report({ state: 'succeeded' }), T1)).toThrow(
      IllegalRunTransitionError,
    );
  });

  it.each([
    'queued',
    'waiting_for_operator',
    'succeeded',
    'failed',
    'cancelled',
    'timed_out',
  ] as const)('refuses a worker that does not hold a %s Run', (state) => {
    const run = inState(state, { releasedBy: OTHER_WORKER });

    expect(() => run.reportState(WORKER, report({ state: 'running' }), T1)).toThrow(
      RunNotHeldError,
    );
    expect(run.pendingChanges().fields).toEqual({});
  });

  it('refuses another worker than the one that holds the Run', () => {
    const run = inState('running');

    expect(() => run.reportState(OTHER_WORKER, report({ state: 'succeeded' }), T1)).toThrow(
      RunNotHeldError,
    );
  });

  it.each([
    ['running', 'running'],
    ['waiting_for_operator', 'waiting_for_operator'],
    ['succeeded', 'succeeded'],
  ] as const)(
    'takes the repeat of a report already applied (%s) as nothing to do',
    (state, reported) => {
      const run = inState(state);

      expect(run.reportState(WORKER, report({ state: reported }), T1)).toBe(false);

      expect(run.pendingChanges().fields).toEqual({});
    },
  );

  it('refuses the repeat of a report from a worker that did not release the Run', () => {
    const run = inState('waiting_for_operator', { releasedBy: OTHER_WORKER });

    expect(() => run.reportState(WORKER, report({ state: 'waiting_for_operator' }), T1)).toThrow(
      RunNotHeldError,
    );
  });

  it('records where a bring-up-to-date merge started when the part goes to running', () => {
    const run = inState('preparing', { messages: BRING_UP, sessionRef: 'session-1' });

    run.reportState(
      WORKER,
      report({
        bringUpToDateStarted: { baseCommit: 'b'.repeat(40), integrationCommit: 'd'.repeat(40) },
      }),
      T1,
    );

    expect(run.pendingChanges().followUpEntry).toEqual({
      updateBase: 'b'.repeat(40),
      updateTip: 'd'.repeat(40),
    });
  });

  it('records the merged commit of a bring-up-to-date part that succeeded', () => {
    const run = inState('running', {
      messages: [
        BRING_UP[0]!,
        {
          kind: 'follow_up',
          text: '',
          at: T0,
          source: 'bring_up_to_date',
          updateBase: 'b'.repeat(40),
          updateTip: 'd'.repeat(40),
        },
      ],
    });

    run.reportState(WORKER, report({ state: 'succeeded', delivery: { outcome: 'none' } }), T1);

    expect(run.pendingChanges().followUpEntry).toEqual({ mergedCommit: 'd'.repeat(40) });
  });
});

describe('the outcome of a delivery retry the agent worker reports', () => {
  it('finishes the Run as succeeded with the delivery, releases it and ends the request', () => {
    const run = retrying();

    expect(
      run.reportState(
        WORKER,
        report({
          state: 'succeeded',
          delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
        }),
        T1,
      ),
    ).toBe(true);

    expect(run).toMatchObject({
      lifecycle: { state: 'succeeded', failure: null, finishedAt: T1 },
      delivery: { state: 'delivered', pullRequest: PULL_REQUEST, requested: false },
      claim: { claimedBy: null, heartbeatAt: null, releasedBy: WORKER },
    });
  });

  it('keeps a delivery that failed again as failed, with the new reason and the pushed commit', () => {
    const run = retrying();
    const again = { code: 'delivery_failed', detail: 'Refused again.' } as const;

    run.reportState(
      WORKER,
      report({ state: 'failed', failure: again, pushedCommit: 'e'.repeat(40) }),
      T1,
    );

    expect(run).toMatchObject({
      lifecycle: { state: 'failed', failure: again, finishedAt: T1 },
      delivery: { state: 'failed', requested: false, pushedCommit: 'e'.repeat(40) },
      claim: { claimedBy: null },
    });
  });

  it.each([
    ['running', report({ state: 'running' })],
    [
      'a failure that is not the delivery',
      report({ state: 'failed', failure: { code: 'unknown', detail: 'x' } }),
    ],
    ['succeeded without a delivery', report({ state: 'succeeded' })],
  ])('refuses %s as the outcome', (_name, outcome) => {
    const run = retrying();

    expect(() => run.reportState(WORKER, outcome, T1)).toThrow(IllegalRunTransitionError);
    expect(run.pendingChanges().fields).toEqual({});
  });

  it('is a repeat, not a retry outcome, once the worker released the Run', () => {
    const run = inState('succeeded', { delivery: 'delivered', pullRequest: PULL_REQUEST });

    expect(
      run.reportState(
        WORKER,
        report({
          state: 'succeeded',
          delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
        }),
        T1,
      ),
    ).toBe(false);
  });

  it('refuses another worker than the one holding the retry', () => {
    const run = retrying();

    expect(() =>
      run.reportState(
        OTHER_WORKER,
        report({ state: 'succeeded', delivery: { outcome: 'none' } }),
        T1,
      ),
    ).toThrow(RunNotHeldError);
  });
});

describe('a bring-up-to-date request that changed nothing', () => {
  const unchanged = (detail: string | null = null): RunStateReport =>
    report({ state: 'succeeded', unchanged: true, unchangedDetail: detail });
  const requested = () =>
    inState('running', {
      messages: BRING_UP,
      sessionRef: 'session-1',
      stepCount: 1,
      delivery: null,
    });

  it('returns the Run to the result it had before and notes that nothing was changed', () => {
    const run = requested();

    expect(run.reportState(WORKER, unchanged('Nothing to merge.'), T1)).toBe(true);

    expect(run).toMatchObject({
      lifecycle: { state: 'succeeded', finishedAt: T1 },
      delivery: { state: 'delivered' },
      claim: { claimedBy: null, heartbeatAt: null, releasedBy: WORKER },
      progress: { stepStartedAt: null },
    });
    expect(run.conversation.messages.at(-1)).toEqual({
      kind: 'part_end',
      state: 'succeeded',
      failureCode: null,
      delivery: 'delivered',
      detail: 'Nothing to merge.',
      at: T1,
    });
  });

  it('says why in words of its own when the worker gave none', () => {
    const run = requested();

    run.reportState(WORKER, unchanged(), T1);

    expect(run.conversation.messages.at(-1)).toMatchObject({
      kind: 'part_end',
      detail: expect.stringContaining('already has everything dev has'),
    });
  });

  it('takes a repeat of the report as nothing to do', () => {
    const run = inState('succeeded', { messages: BRING_UP, releasedBy: WORKER });

    expect(run.reportState(WORKER, unchanged(), T1)).toBe(false);
  });

  it('refuses a worker that does not hold the Run', () => {
    const run = requested();

    expect(() => run.reportState(OTHER_WORKER, unchanged(), T1)).toThrow(RunNotHeldError);
  });

  it.each([
    [
      'a Run whose latest Follow-up is not a bring-up request',
      [BRING_UP[0]!, { kind: 'follow_up', text: 'x', at: T0 } as const],
    ],
    ['a Run without a Follow-up', []],
  ])('refuses %s', (_name, messages) => {
    const run = inState('running', { messages: [...messages] });

    expect(() => run.reportState(WORKER, unchanged(), T1)).toThrow(IllegalRunTransitionError);
  });
});

describe('a Run step the agent worker reports', () => {
  const step = { kind: 'start' as const, result: { outcome: 'done' } };

  it('stores the step as number 1, with the Working copy, the failing checks and the session', () => {
    const run = inState('running');

    const outcome = run.reportStep(
      WORKER,
      { ...step, sessionRef: 'session-1' },
      WORKING_COPY,
      ['lint'],
      T1,
    );

    expect(outcome).toEqual({ status: 'stored', index: 1 });
    expect(run).toMatchObject({
      workingCopy: WORKING_COPY,
      failingChecks: ['lint'],
      progress: { stepCount: 1, stepStartedAt: null, lastActivityAt: T1 },
      claim: { sessionRef: 'session-1' },
      lifecycle: { state: 'running' },
    });
    expect(run.pendingChanges().steps).toEqual([
      { index: 1, kind: 'start', result: { outcome: 'done' } },
    ]);
  });

  it('stores the question of a step as the Run next message', () => {
    const run = inState('running');
    const question = { text: 'Which database?', options: ['PostgreSQL', 'SQLite'] };

    run.reportStep(WORKER, { ...step, question }, WORKING_COPY, [], T1);

    expect(run.conversation.messages.at(-1)).toEqual({ kind: 'question', question, at: T1 });
    expect(run.pendingChanges().messages).toEqual([{ kind: 'question', question, at: T1 }]);
  });

  it('numbers the steps in report order and accepts the number the worker reports', () => {
    const run = inState('running', { stepCount: 1 });

    expect(run.reportStep(WORKER, { ...step, index: 2 }, WORKING_COPY, [], T1)).toEqual({
      status: 'stored',
      index: 2,
    });
  });

  it('acknowledges a step that is already stored without storing it again', () => {
    const run = inState('running', { stepCount: 2 });

    expect(run.reportStep(WORKER, { ...step, index: 2 }, WORKING_COPY, [], T1)).toEqual({
      status: 'stored',
      index: 2,
      duplicate: true,
    });

    expect(run.pendingChanges().fields).toEqual({});
    expect(run.pendingChanges().steps).toBeUndefined();
  });

  it('refuses a number that is neither the last one nor the next, changing nothing', () => {
    const run = inState('running', { stepCount: 1 });

    expect(() => run.reportStep(WORKER, { ...step, index: 4 }, WORKING_COPY, [], T1)).toThrow(
      new StepOutOfOrderError(2),
    );
    expect(run.pendingChanges().fields).toEqual({});
  });

  it('fails the Run instead of storing a step beyond the limit', () => {
    const run = inState('running', { stepCount: 2 });

    expect(run.reportStep(WORKER, step, WORKING_COPY, [], T1)).toEqual({ status: 'step_limit' });

    expect(run).toMatchObject({
      lifecycle: { state: 'failed', failure: { code: 'step_limit' }, finishedAt: T1 },
      claim: { claimedBy: null, heartbeatAt: null },
      progress: { stepCount: 2 },
    });
    expect(run.pendingChanges().steps).toBeUndefined();
  });

  it('gives a Follow-up its own allowance from the steps taken before it', () => {
    const run = inState('running', {
      stepCount: 3,
      stepsBeforePart: 2,
      followUpCount: 1,
      messages: [{ kind: 'follow_up', text: 'More.', at: T0 }],
    });

    expect(run.reportStep(WORKER, step, WORKING_COPY, [], T1)).toEqual({
      status: 'stored',
      index: 4,
    });
    expect(run.reportStep(WORKER, step, WORKING_COPY, [], T1)).toEqual({ status: 'step_limit' });
    expect(run.lifecycle.failure?.detail).toContain(
      'The Follow-up reached its limit of 2 run steps',
    );
  });

  it.each(['queued', 'preparing', 'waiting_for_operator', 'succeeded', 'failed'] as const)(
    'refuses a step of a %s Run',
    (state) => {
      const run = inState(state, { claimedBy: state === 'preparing' ? WORKER : null });

      expect(() => run.reportStep(WORKER, step, WORKING_COPY, [], T1)).toThrow(RunNotHeldError);
    },
  );

  it('refuses a step from a worker that does not hold the Run', () => {
    const run = inState('running');

    expect(() => run.reportStep(OTHER_WORKER, step, WORKING_COPY, [], T1)).toThrow(RunNotHeldError);
  });
});

describe('a heartbeat the agent worker sends', () => {
  it('renews the lease of the worker that holds the Run and tells whether a cancel was asked', () => {
    const run = inState('running', { cancelRequestedAt: T0 });

    expect(run.recordHeartbeat(WORKER, T1)).toEqual({ cancelRequested: true });

    expect(run.claim.heartbeatAt).toEqual(T1);
    expect(run.pendingChanges().fields).toEqual({ heartbeatAt: T1 });
  });

  it('also renews the lease of a failed Run the worker holds for a delivery retry', () => {
    const run = retrying();

    expect(run.recordHeartbeat(WORKER, T1)).toEqual({ cancelRequested: false });
  });

  it.each(['queued', 'waiting_for_operator', 'succeeded', 'failed'] as const)(
    'refuses a heartbeat for a %s Run nobody holds',
    (state) => {
      const run = inState(state);

      expect(() => run.recordHeartbeat(WORKER, T1)).toThrow(RunNotHeldError);
      expect(run.pendingChanges().fields).toEqual({});
    },
  );

  it('refuses a worker that lost the claim to another', () => {
    const run = inState('running');

    expect(() => run.recordHeartbeat(OTHER_WORKER, T1)).toThrow(RunNotHeldError);
  });
});

describe('the removal of a Working copy the agent worker reports', () => {
  it('records it for a Run the worker last claimed and no longer holds', () => {
    const run = inState('succeeded');

    expect(run.reportWorkingCopyRemoved(WORKER, T1)).toBe(true);

    expect(run.claim.workingCopyRemovedAt).toEqual(T1);
  });

  it('also records it for a Run queued for a Follow-up meanwhile', () => {
    const run = inState('queued', {
      lastClaimedBy: WORKER,
      followUpQueued: true,
      followUpCount: 1,
    });

    expect(run.reportWorkingCopyRemoved(WORKER, T1)).toBe(true);
  });

  it.each([
    ['a Run the worker still holds', inState('running')],
    ['a Run another worker last claimed', inState('succeeded', { lastClaimedBy: OTHER_WORKER })],
    ['a Run whose removal is recorded already', inState('succeeded', { workingCopyRemovedAt: T0 })],
    ['a Run that was never claimed', inState('queued')],
  ])('records nothing for %s', (_name, run) => {
    expect(run.reportWorkingCopyRemoved(WORKER, T1)).toBe(false);

    expect(run.pendingChanges().fields).toEqual({});
  });
});

describe('the Environment file the claim gives a Run', () => {
  const file = { path: '.env', secretRef: 'snapshot-1' };

  it('records the path and the snapshot of a preparing Run the worker holds', () => {
    const run = inState('preparing');

    run.recordEnvironmentFile(WORKER, file);

    expect(run).toMatchObject({
      claim: { environmentFileSupplied: true, environmentFilePath: '.env' },
    });
    expect(run.pendingChanges().environmentFileSecretRef).toBe('snapshot-1');
  });

  it('records that the Project has no file now', () => {
    const run = inState('preparing', {
      environmentFileSupplied: true,
      environmentFilePath: '.env',
    });

    run.recordEnvironmentFile(WORKER, null);

    expect(run).toMatchObject({
      claim: { environmentFileSupplied: false, environmentFilePath: null },
    });
    expect(run.pendingChanges().environmentFileSecretRef).toBeNull();
  });

  it.each(['queued', 'running', 'succeeded'] as const)('refuses a %s Run', (state) => {
    expect(() => inState(state).recordEnvironmentFile(WORKER, file)).toThrow(RunNotHeldError);
  });

  it('refuses a worker that does not hold the Run', () => {
    expect(() => inState('preparing').recordEnvironmentFile(OTHER_WORKER, file)).toThrow(
      RunNotHeldError,
    );
  });
});

describe('a claim that could not prepare the Run', () => {
  const failure = { code: 'preparation_failed', detail: 'No remote.' } as const;

  it('fails the preparing Run the worker holds, released and finished now', () => {
    const run = inState('preparing');

    expect(run.failPreparation(WORKER, failure, T1)).toBe(true);

    expect(run).toMatchObject({
      lifecycle: { state: 'failed', failure, finishedAt: T1 },
      claim: { claimedBy: null, heartbeatAt: null, releasedBy: WORKER },
    });
  });

  it.each([
    ['a running Run', inState('running')],
    ['a Run with a cancel request', inState('preparing', { cancelRequestedAt: T0 })],
    ['a Run another worker holds', inState('preparing', { claimedBy: OTHER_WORKER })],
  ])('changes nothing for %s', (_name, run) => {
    expect(run.failPreparation(WORKER, failure, T1)).toBe(false);

    expect(run.pendingChanges().fields).toEqual({});
  });
});
