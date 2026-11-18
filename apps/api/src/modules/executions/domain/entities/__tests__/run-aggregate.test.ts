import { describe, expect, it } from 'vitest';
import { Run } from '../run.js';
import { type RunSnapshot } from '../run-snapshot.js';
import { RunNotHeldError } from '../../errors/run-errors.js';
import { Task } from '../../value-objects/task.js';

// Issue #183: the Run's snapshot, the Run step it creates, what the lookups change of its pull
// request status, and the held-Run rule of the Run diff.
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
  task: Task.of('Add a health check'),
  startCommit: 'a'.repeat(40),
  remoteUrl: 'https://git.example.test/a.git',
  integrationBranch: 'dev',
  limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 10 },
  now: T0,
});
const restored = (patch: Partial<RunSnapshot>) => Run.restore({ ...started.snapshot(), ...patch });
const running = (patch: Partial<RunSnapshot> = {}) =>
  restored({ state: 'running', claimedBy: WORKER, lastClaimedBy: WORKER, ...patch });
const delivered = (patch: Partial<RunSnapshot> = {}) =>
  restored({
    state: 'succeeded',
    delivery: 'delivered',
    pullRequest: PULL_REQUEST,
    workingCopy: WORKING_COPY,
    finishedAt: T0,
    ...patch,
  });

describe('Run.snapshot', () => {
  it('is the Run flat, as storage holds it, and a copy', () => {
    const run = running({ stepCount: 2 });

    const snapshot = run.snapshot();

    expect(snapshot).toMatchObject({ id: run.id, state: 'running', stepCount: 2, task: run.task });
    expect(Run.restore(snapshot).snapshot()).toEqual(snapshot);
    expect(snapshot).not.toBeInstanceOf(Run);
    expect(Object.keys(snapshot)).not.toContain('pendingChanges');
  });
});

// Issue #184: the Run is its value objects, and storage still holds the flat record. Every field of
// a stored Run, set to a value that is not its default, goes through the grouped objects and back.
describe('restoring a Run from its flat record and giving it back (Issue #184)', () => {
  const sessionRef = 'agent-session-1';
  const full: RunSnapshot = {
    id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
    projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
    provider: 'claude_code',
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

    expect(run.snapshot()).toEqual(full);
    // Nothing is lost between the groups: the record has exactly the fields the Run keeps.
    expect(Object.keys(run.snapshot()).sort()).toEqual(Object.keys(full).sort());
    // And the Run reads them through its value objects, one per concept.
    expect(run.lifecycle.state).toBe('failed');
    expect(run.delivery.state).toBe('failed');
    expect(run.delivery.requested).toBe(true);
    expect(run.claim.sessionRef).toBe(sessionRef);
    expect(run.progress.limits).toEqual(full.limits);
    expect(run.pullRequestStatus.toStored()).toEqual(full.pullRequestStatus);
    expect(run.conversation.messages).toEqual(full.messages);
    expect(run.pendingChanges()).toEqual({ fields: {}, messages: [] });
  });

  it('is a copy: changing the Run later does not change the snapshot taken before', () => {
    const run = Run.restore(full);
    const before = run.snapshot();

    run.recordHeartbeat(WORKER, T0);

    expect(before.heartbeatAt).toEqual(T2);
    expect(run.snapshot().heartbeatAt).toEqual(T0);
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

    // The limit is the Run's: the next step is over its allowance of 3, so the Run fails.
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
    refreshing.recordRefreshRequested(T1);
    expect(refreshing.pullRequestStatus).toMatchObject({
      refreshRequestedAt: T1,
      lastAttemptAt: T1,
      prepareRequestedAt: null,
    });

    const preparing = delivered({
      pullRequestStatus: { ...started.pullRequestStatus, prepareError: 'Earlier failure.' },
    });
    preparing.recordPreparationRequested(T1);
    expect(preparing.pullRequestStatus).toMatchObject({
      prepareRequestedAt: T1,
      prepareError: null,
      refreshRequestedAt: null,
      lastAttemptAt: null,
    });
    expect(preparing.pendingChanges().fields.pullRequestStatus).toEqual(
      preparing.pullRequestStatus.toStored(),
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

    run.recordRefreshFailed('Rate limited.', T2, T0);
    expect(run.pullRequestStatus).toMatchObject({
      refreshError: 'Rate limited.',
      retryAt: T2,
      refreshRequestedAt: T0,
    });
    run.recordRefreshFailed('Gave up.', null, T0);
    expect(run.pullRequestStatus).toMatchObject({ retryAt: null, refreshRequestedAt: null });
    run.recordPreparationFailed('No logs.', null, T0);
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
