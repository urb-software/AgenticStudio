import { describe, expect, it } from 'vitest';
import { Run } from '../run.js';
import { type RestoreData } from '../../../../../__tests__/restore-data.js';
import { RunNotHeldError } from '../../errors/run-errors.js';
import { RunPullRequestStatus } from '../../value-objects/run-pull-request-status.js';
import { Task } from '../../value-objects/task.js';
import { defaultAgentOf } from '../../repositories/__tests__/in-memory-run-repository.js';

const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-17T10:00:00.000Z');
const T1 = new Date('2026-11-17T11:00:00.000Z');
const T2 = new Date('2026-11-17T12:00:00.000Z');
const WORKING_COPY = { runBranch: 'agent/x-r1', commits: [], hasUncommittedChanges: false };
const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };

const started = Run.start({
  id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'codex',
  agent: defaultAgentOf('codex'),
  task: Task.of('Add a health check'),
  startCommit: 'a'.repeat(40),
  remoteUrl: 'https://git.example.test/a.git',
  integrationBranch: 'dev',
  limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 10 },
  now: T0,
});
const STARTED_DATA: RestoreData<typeof Run> = {
  id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'codex',
  agent: defaultAgentOf('codex'),
  task: 'Add a health check',
  startCommit: 'a'.repeat(40),
  remoteUrl: 'https://git.example.test/a.git',
  createdAt: T0,
  state: 'queued',
  startedAt: null,
  finishedAt: null,
  failure: null,
  cancellation: null,
  cancelRequestedAt: null,
  integrationBranch: 'dev',
  delivery: null,
  pullRequest: null,
  deliveryRequested: false,
  pushedCommit: null,
  claimedBy: null,
  lastClaimedBy: null,
  releasedBy: null,
  heartbeatAt: null,
  sessionRef: null,
  workingCopyRemovedAt: null,
  environmentFileSupplied: false,
  environmentFilePath: null,
  stepCount: 0,
  stepsBeforePart: 0,
  followUpCount: 0,
  followUpQueued: false,
  stepStartedAt: null,
  waitingSince: null,
  lastActivityAt: T0,
  limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 10 },
  workingCopy: null,
  failingChecks: [],
  pullRequestStatus: RunPullRequestStatus.none().toData(),
  messages: [],
};
const restored = (patch: Partial<RestoreData<typeof Run>>) =>
  Run.restore({ ...STARTED_DATA, ...patch });
const running = (patch: Partial<RestoreData<typeof Run>> = {}) =>
  restored({ state: 'running', claimedBy: WORKER, lastClaimedBy: WORKER, ...patch });
const delivered = (patch: Partial<RestoreData<typeof Run>> = {}) =>
  restored({
    state: 'succeeded',
    delivery: 'delivered',
    pullRequest: PULL_REQUEST,
    workingCopy: WORKING_COPY,
    finishedAt: T0,
    ...patch,
  });

describe('Run.start', () => {
  it('builds the Run that restore gives for the same data', () => {
    expect(started).toEqual(Run.restore(STARTED_DATA));
    expect(started.pendingChanges()).toEqual({ fields: {}, messages: [] });
  });
});

describe('restoring a Run from its flat record and giving it back', () => {
  const sessionRef = 'agent-session-1';
  const full: RestoreData<typeof Run> = {
    id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
    projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
    provider: 'claude_code',
    agent: defaultAgentOf('claude_code'),
    task: 'Add a health check',
    startCommit: 'a'.repeat(40),
    remoteUrl: 'https://git.example.test/a.git',
    createdAt: T0,
    state: 'failed',
    startedAt: T0,
    finishedAt: T2,
    failure: { code: 'delivery_failed', detail: 'The push was rejected.' },
    cancellation: null,
    cancelRequestedAt: T1,
    integrationBranch: 'main',
    delivery: 'failed',
    pullRequest: PULL_REQUEST,
    deliveryRequested: true,
    pushedCommit: 'b'.repeat(40),
    claimedBy: WORKER,
    lastClaimedBy: WORKER,
    releasedBy: '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e',
    heartbeatAt: T2,
    sessionRef,
    workingCopyRemovedAt: T1,
    environmentFileSupplied: true,
    environmentFilePath: 'config/.env',
    stepCount: 4,
    stepsBeforePart: 2,
    followUpCount: 1,
    followUpQueued: true,
    stepStartedAt: T1,
    waitingSince: T1,
    lastActivityAt: T2,
    limits: { stepMinutes: 30, maxSteps: 6, waitingDays: 7, maxTotalSteps: 20 },
    workingCopy: {
      runBranch: 'agent/x-r1',
      commits: [{ id: 'c'.repeat(40), subject: 'Add the endpoint' }],
      hasUncommittedChanges: true,
    },
    failingChecks: ['lint', 'unit'],
    pullRequestStatus: {
      state: 'open',
      behindBy: 3,
      aheadBy: 2,
      mergeable: false,
      refreshedAt: T1,
      refreshError: 'The Git host could not be reached.',
      retryAt: T2,
      refreshRequestedAt: T0,
      lastAttemptAt: T1,
      checks: {
        commit: 'd'.repeat(40),
        checks: [{ name: 'build', state: 'failed', url: 'https://ci.example.test/1' }],
      },
      prepareRequestedAt: T0,
      prepareError: 'The log could not be read.',
      endedAt: T2,
      closeClaimedAt: T0,
      closedFromStudioAt: T1,
      runBranchDeletedAt: null,
      runBranchDeletionFailure: 'The host refused.',
    },
    messages: [
      { kind: 'question', question: { text: 'Which?', options: ['a', 'b'] }, at: T0 },
      { kind: 'answer', text: 'a', at: T1 },
      {
        kind: 'follow_up',
        text: 'Also add tests.',
        at: T1,
        source: 'bring_up_to_date',
        updateBase: 'e'.repeat(40),
        updateTip: 'f'.repeat(40),
        mergedCommit: 'f'.repeat(40),
      },
    ],
  };

  it('gives back every field, as it was stored', () => {
    const run = Run.restore(full);

    expect(Object.keys(run).sort()).toEqual(
      [
        'agent',
        'checkpointItem',
        'claim',
        'conversation',
        'createdAt',
        'currentPhase',
        'delivery',
        'failingChecks',
        'id',
        'lifecycle',
        'phasePending',
        'progress',
        'projectId',
        'provider',
        'pullRequestStatus',
        'remoteUrl',
        'startCommit',
        'task',
        'workflow',
        'workflowEnded',
        'workingCopy',
      ].sort(),
    );
    expect(run).toMatchObject({
      id: full.id,
      projectId: full.projectId,
      provider: full.provider,
      task: full.task,
      startCommit: full.startCommit,
      remoteUrl: full.remoteUrl,
      createdAt: full.createdAt,
      lifecycle: {
        state: full.state,
        startedAt: full.startedAt,
        finishedAt: full.finishedAt,
        failure: full.failure,
        cancellation: full.cancellation,
        cancelRequestedAt: full.cancelRequestedAt,
      },
      delivery: {
        integrationBranch: full.integrationBranch,
        state: full.delivery,
        pullRequest: full.pullRequest,
        requested: full.deliveryRequested,
        pushedCommit: full.pushedCommit,
      },
      claim: {
        claimedBy: full.claimedBy,
        lastClaimedBy: full.lastClaimedBy,
        releasedBy: full.releasedBy,
        heartbeatAt: full.heartbeatAt,
        sessionRef: full.sessionRef,
        workingCopyRemovedAt: full.workingCopyRemovedAt,
        environmentFileSupplied: full.environmentFileSupplied,
        environmentFilePath: full.environmentFilePath,
      },
      progress: {
        stepCount: full.stepCount,
        stepsBeforePart: full.stepsBeforePart,
        followUpCount: full.followUpCount,
        followUpQueued: full.followUpQueued,
        stepStartedAt: full.stepStartedAt,
        waitingSince: full.waitingSince,
        lastActivityAt: full.lastActivityAt,
        limits: full.limits,
      },
      conversation: { messages: full.messages },
      workingCopy: full.workingCopy,
      failingChecks: full.failingChecks,
    });
    expect(run.lifecycle.state).toBe('failed');
    expect(run.delivery.state).toBe('failed');
    expect(run.delivery.requested).toBe(true);
    expect(run.claim.sessionRef).toBe(sessionRef);
    expect(run.progress.limits).toEqual(full.limits);
    expect(run.pullRequestStatus.toData()).toEqual(full.pullRequestStatus);
    expect(run.conversation.messages).toEqual(full.messages);
    expect(run.pendingChanges()).toEqual({ fields: {}, messages: [] });
  });

  it('shares no state with another Run restored from the same data', () => {
    const run = Run.restore(full);
    const other = Run.restore(full);

    run.recordHeartbeat(WORKER, T0);

    expect(other.claim.heartbeatAt).toEqual(T2);
    expect(run.claim.heartbeatAt).toEqual(T0);
  });

  it('copies the arrays and the working copy it is restored from', () => {
    const source = {
      ...full,
      failingChecks: ['lint'],
      workingCopy: {
        runBranch: 'studio/run',
        commits: [{ id: 'b'.repeat(40), subject: 'Add it' }],
        hasUncommittedChanges: false,
      },
    } as unknown as RestoreData<typeof Run> & {
      failingChecks: string[];
      workingCopy: { commits: unknown[]; runBranch: string };
    };
    const run = Run.restore(source);
    const other = Run.restore(source);

    source.failingChecks.push('tests');
    source.workingCopy.commits.push({ id: 'c'.repeat(40), subject: 'Later' });
    source.workingCopy.runBranch = 'changed';

    for (const restoredRun of [run, other]) {
      expect(restoredRun.failingChecks).toEqual(['lint']);
      expect(restoredRun.workingCopy?.commits).toHaveLength(1);
      expect(restoredRun.workingCopy?.runBranch).toBe('studio/run');
    }
  });

  it('writes only the fields an operation changed', () => {
    const run = running({ stepCount: 1 });

    run.recordHeartbeat(WORKER, T2);

    expect(run.pendingChanges().fields).toEqual({ heartbeatAt: T2 });
    expect(run.pendingChanges().messages).toEqual([]);

    const answered = restored({
      state: 'waiting_for_operator',
      waitingSince: T0,
      messages: [{ kind: 'question', question: { text: 'Which?' }, at: T0 }],
    });
    answered.answer('This one.', T1);
    expect(Object.keys(answered.pendingChanges().fields).sort()).toEqual([
      'lastActivityAt',
      'state',
      'waitingSince',
    ]);
    expect(answered.pendingChanges().messages).toEqual([
      { kind: 'answer', text: 'This one.', at: T1 },
    ]);
  });
});

describe('the Run step', () => {
  const report = (run: Run, index?: number) =>
    run.reportStep(
      WORKER,
      { kind: 'start', result: { outcome: 'done' }, ...(index === undefined ? {} : { index }) },
      WORKING_COPY,
      [],
      T1,
    );

  it('is created by the Run, numbered from the steps it counts, and bounded by its allowance', () => {
    const run = running({ stepCount: 2 });

    expect(report(run)).toEqual({ status: 'stored', index: 3 });
    expect(run.pendingChanges().steps).toEqual([
      { index: 3, kind: 'start', result: { outcome: 'done' } },
    ]);
    expect(run.progress.stepCount).toBe(3);

    expect(report(run)).toEqual({ status: 'step_limit' });
    expect(run.lifecycle.state).toBe('failed');
    expect(run.pendingChanges().steps).toHaveLength(1);
  });

  it('is not created again for a number already stored', () => {
    const run = running({ stepCount: 2 });

    expect(report(run, 2)).toEqual({ status: 'stored', index: 2, duplicate: true });
    expect(run.pendingChanges().steps).toBeUndefined();
  });
});

describe('what the lookups change of the pull request status', () => {
  it('marks a state refresh and a preparation as asked for, the preparation not as an attempt', () => {
    const refreshing = delivered();
    refreshing.recordLookupRequested('pull_request_state', T1);
    expect(refreshing.pullRequestStatus).toMatchObject({
      refreshRequestedAt: T1,
      lastAttemptAt: T1,
      prepareRequestedAt: null,
    });

    const preparing = delivered({
      pullRequestStatus: { ...started.pullRequestStatus, prepareError: 'Earlier failure.' },
    });
    preparing.recordLookupRequested('failing_check_logs', T1);
    expect(preparing.pullRequestStatus).toMatchObject({
      prepareRequestedAt: T1,
      prepareError: null,
      refreshRequestedAt: null,
      lastAttemptAt: null,
    });
    expect(preparing.pendingChanges().fields.pullRequestStatus).toEqual(
      preparing.pullRequestStatus.toData(),
    );
  });

  it('replaces what is known with the answer, keeps the first end, and a reopen clears it', () => {
    const run = delivered();
    const answer = (state: 'open' | 'merged' | 'closed', at: Date) =>
      run.recordPullRequestState({ state, behindBy: 1, aheadBy: 2, mergeable: true }, at);

    answer('merged', T1);
    expect(run.pullRequestStatus).toMatchObject({ state: 'merged', refreshedAt: T1, endedAt: T1 });
    answer('closed', T2);
    expect(run.pullRequestStatus.endedAt).toEqual(T1);
    answer('open', T2);
    expect(run.pullRequestStatus).toMatchObject({ state: 'open', endedAt: null, behindBy: 1 });
  });

  it('keeps the checks only as the answer gives them, and the marker that the host refused', () => {
    const run = delivered();

    run.recordPullRequestState({ state: 'open' }, T1);
    expect(run.pullRequestStatus.checks).toBeNull();
    run.recordPullRequestState({ state: 'open', checksUnavailable: true }, T1);
    expect(run.pullRequestStatus.checks).toEqual({ unavailable: true });
    run.recordPullRequestState({ state: 'open', checksCommit: 'c'.repeat(40), checks: [] }, T1);
    expect(run.pullRequestStatus.checks).toEqual({ commit: 'c'.repeat(40), checks: [] });
  });

  it('leaves a Run without a pull request alone', () => {
    const run = running();

    run.recordPullRequestState({ state: 'open' }, T1);
    run.recordObservedPullRequestState('merged', T1);

    expect(run.pendingChanges().fields).toEqual({});
  });

  it('records a failure, staying refreshing or preparing only while a retry is waiting', () => {
    const run = delivered();

    run.recordLookupFailed('pull_request_state', 'Rate limited.', T2, T0);
    expect(run.pullRequestStatus).toMatchObject({
      refreshError: 'Rate limited.',
      retryAt: T2,
      refreshRequestedAt: T0,
    });
    run.recordLookupFailed('pull_request_state', 'Gave up.', null, T0);
    expect(run.pullRequestStatus).toMatchObject({ retryAt: null, refreshRequestedAt: null });
    run.recordLookupFailed('failing_check_logs', 'No logs.', null, T0);
    expect(run.pullRequestStatus).toMatchObject({
      prepareError: 'No logs.',
      prepareRequestedAt: null,
    });
    run.recordPreparationDone();
    expect(run.pullRequestStatus).toMatchObject({ prepareError: null, prepareRequestedAt: null });
  });

  it('clears what an ended pull request cannot have when the worker reads it on its own', () => {
    const run = delivered({
      pullRequestStatus: {
        ...started.pullRequestStatus,
        state: 'open',
        behindBy: 3,
        aheadBy: 1,
        mergeable: true,
        checks: { commit: 'c'.repeat(40), checks: [] },
      },
    });

    run.recordObservedPullRequestState('closed', T1);
    expect(run.pullRequestStatus).toMatchObject({
      state: 'closed',
      behindBy: 3,
      aheadBy: 1,
      mergeable: null,
      checks: null,
      endedAt: T1,
    });
    run.recordObservedPullRequestState('missing', T2);
    expect(run.pullRequestStatus).toMatchObject({ behindBy: null, aheadBy: null, endedAt: T1 });
  });

  it('leaves the pull request status alone for the review comments lookup', () => {
    const run = delivered({
      pullRequestStatus: { ...started.pullRequestStatus, state: 'open', prepareError: 'Earlier.' },
    });
    const before = run.pullRequestStatus.toData();

    run.recordLookupRequested('review_comments', T1);
    run.recordLookupFailed('review_comments', 'No comments.', T2, T1);

    expect(run.pullRequestStatus.toData()).toEqual(before);
  });
});

describe('Run.resumable', () => {
  const stopped = (patch: Partial<RestoreData<typeof Run>> = {}) =>
    restored({
      state: 'failed',
      failure: { code: 'usage_limit', detail: 'The usage limit was reached.' },
      finishedAt: T1,
      sessionRef: 'session-1',
      workingCopy: WORKING_COPY,
      ...patch,
    });

  it('is true for a Run stopped at the usage limit with a session and a Working copy', () => {
    expect(stopped().resumable).toBe(true);
  });

  it.each([
    ['another failure', { failure: { code: 'agent_failed' as const, detail: 'x' } }],
    ['no session', { sessionRef: null }],
    ['no Working copy', { workingCopy: null }],
    ['a cancel request', { cancelRequestedAt: T2 }],
  ])('is false with %s', (_case, change) => {
    expect(stopped(change).resumable).toBe(false);
  });
});

describe('Run.openQuestion', () => {
  const QUESTION = {
    text: 'Which database?',
    options: ['PostgreSQL'],
    recommendation: 'PostgreSQL',
  };
  const asked = (patch: Partial<RestoreData<typeof Run>> = {}) =>
    restored({
      state: 'waiting_for_operator',
      messages: [{ kind: 'question', question: QUESTION, at: T1 }],
      ...patch,
    });

  it('is the last question of a Run waiting for the operator', () => {
    expect(asked().openQuestion).toEqual(QUESTION);
  });

  it('is none once answered, outside waiting, or before any question', () => {
    expect(
      asked({
        state: 'queued',
        messages: [
          { kind: 'question', question: QUESTION, at: T1 },
          { kind: 'answer', text: 'PostgreSQL', at: T2 },
        ],
      }).openQuestion,
    ).toBeNull();
    expect(
      asked({ state: 'running', claimedBy: WORKER, lastClaimedBy: WORKER }).openQuestion,
    ).toBeNull();
    expect(asked({ messages: [] }).openQuestion).toBeNull();
  });
});

describe('Run.commitsPushed', () => {
  const C1 = 'c'.repeat(40);
  const C2 = 'd'.repeat(40);
  const C3 = 'e'.repeat(40);
  const withCommits = (pushedCommit: string | null) =>
    delivered({
      pushedCommit,
      workingCopy: {
        ...WORKING_COPY,
        commits: [
          { id: C1, subject: 'First' },
          { id: C2, subject: 'Second' },
          { id: C3, subject: 'Third' },
        ],
      },
    });

  it('marks the commits up to the pushed one, later ones only in the Working copy', () => {
    expect(withCommits(C2).commitsPushed()).toEqual([true, true, false]);
    expect(withCommits(null).commitsPushed()).toEqual([false, false, false]);
  });

  it('is unknown when the pushed commit is not listed, or without a Working copy', () => {
    expect(withCommits('f'.repeat(40)).commitsPushed()).toBeNull();
    expect(delivered({ workingCopy: null }).commitsPushed()).toBeNull();
  });
});

describe('Run.assertDiffReportableBy', () => {
  it('lets the worker that holds the Run report, also a failed Run held for a delivery retry', () => {
    expect(() => running().assertDiffReportableBy(WORKER)).not.toThrow();
    expect(() =>
      restored({
        state: 'failed',
        failure: { code: 'delivery_failed', detail: 'x' },
        deliveryRequested: true,
        claimedBy: WORKER,
      }).assertDiffReportableBy(WORKER),
    ).not.toThrow();
  });

  it('refuses another worker, and a Run that is not held in a state that reports', () => {
    expect(() => running().assertDiffReportableBy('someone-else')).toThrow(RunNotHeldError);
    expect(() => started.assertDiffReportableBy(WORKER)).toThrow(RunNotHeldError);
    expect(() =>
      restored({
        state: 'failed',
        failure: { code: 'agent_failed', detail: 'x' },
        claimedBy: WORKER,
      }).assertDiffReportableBy(WORKER),
    ).toThrow(RunNotHeldError);
  });
});
