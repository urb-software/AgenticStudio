import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  followUpEligibility,
  resumeMessage,
  USAGE_LIMIT_RESUME_TEXT,
  canTransition,
  IllegalRunTransitionError,
  isFinal,
  isResumable,
  longWaitCancellation,
  resumeAnswer,
  RUN_STATES,
  type Run,
  type RunState,
  stepLimitFailure,
} from '../run.js';

// Issue #96: the Run state machine, enforced in the domain.
const LEGAL: [RunState, RunState][] = [
  ['queued', 'preparing'],
  ['preparing', 'running'],
  ['preparing', 'failed'],
  ['running', 'waiting_for_operator'],
  ['running', 'succeeded'],
  ['running', 'failed'],
  // Issue #103: the operator's answer queues the Run again; a worker claims it to resume.
  ['waiting_for_operator', 'queued'],
  ['queued', 'cancelled'],
  ['preparing', 'cancelled'],
  ['running', 'cancelled'],
  ['waiting_for_operator', 'cancelled'],
  ['queued', 'timed_out'],
  ['preparing', 'timed_out'],
  ['running', 'timed_out'],
  ['waiting_for_operator', 'timed_out'],
];

describe('Run transitions', () => {
  it('lists the eight states', () => {
    expect(RUN_STATES).toEqual([
      'queued',
      'preparing',
      'running',
      'waiting_for_operator',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
    ]);
  });

  it.each(LEGAL)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('rejects every other transition', () => {
    const legal = new Set(LEGAL.map(([from, to]) => `${from}->${to}`));
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        if (legal.has(`${from}->${to}`)) continue;
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
        expect(() => assertTransition(from, to)).toThrow(IllegalRunTransitionError);
      }
    }
  });

  it('treats succeeded, failed, cancelled and timed_out as final and terminal', () => {
    const final = RUN_STATES.filter(isFinal);
    expect(final).toEqual(['succeeded', 'failed', 'cancelled', 'timed_out']);
    for (const from of final) {
      expect(RUN_STATES.some((to) => canTransition(from, to))).toBe(false);
    }
  });

  it('names both states in the error', () => {
    expect(() => assertTransition('succeeded', 'running')).toThrow(
      'A Run cannot go from succeeded to running.',
    );
  });
});

// Issue #100: the long-wait rule and the step-limit failure.
describe('long-wait rule', () => {
  const since = new Date('2026-11-01T12:00:00.000Z');
  const waiting = (waitingDays: number, overrides: Partial<Run> = {}): Run => ({
    id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
    projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
    provider: 'codex',
    task: 'x',
    state: 'waiting_for_operator',
    startCommit: 'a',
    remoteUrl: 'https://git.example.test/a.git',
    workingCopy: null,
    integrationBranch: 'dev',
    delivery: null,
    pullRequest: null,
    deliveryRequested: false,
    failingChecks: [],
    createdAt: since,
    startedAt: since,
    finishedAt: null,
    failure: null,
    claimedBy: null,
    limits: { stepMinutes: 60, maxSteps: 10, waitingDays, maxTotalSteps: 50 },
    environmentFileSupplied: false,
    environmentFilePath: null,
    cancelRequestedAt: null,
    cancellation: null,
    waitingSince: since,
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
    ...overrides,
  });
  const after = (days: number, extraMs = 0) =>
    new Date(since.getTime() + days * 24 * 60 * 60 * 1000 + extraMs);

  it('leaves a Run waiting exactly its limit alone', () => {
    expect(longWaitCancellation(waiting(14), after(14))).toBeNull();
  });

  it('cancels a Run waiting longer than its limit, by the system, saying why', () => {
    expect(longWaitCancellation(waiting(14), after(14, 1))).toEqual({
      by: 'system',
      reason: 'Cancelled automatically: the run waited for the operator longer than 14 days.',
    });
    expect(longWaitCancellation(waiting(1), after(2))?.reason).toBe(
      'Cancelled automatically: the run waited for the operator longer than 1 day.',
    );
  });

  it('applies only to a Run waiting for the operator', () => {
    expect(
      longWaitCancellation(waiting(1, { state: 'running', waitingSince: null }), after(30)),
    ).toBeNull();
  });
});

describe('step-limit failure', () => {
  it('says which limit was reached and that no further step was started', () => {
    expect(stepLimitFailure(10)).toEqual({
      code: 'step_limit',
      detail: 'The run reached its limit of 10 run steps; no further step was started.',
    });
  });

  it('says a Follow-up reached its own limit (Issue #141)', () => {
    expect(stepLimitFailure(10, true)).toEqual({
      code: 'step_limit',
      detail: 'The Follow-up reached its limit of 10 run steps; no further step was started.',
    });
  });
});

// Issue #103: the agent's open question and the operator's answer that resumes the session.
describe('questions and answers', () => {
  const at = new Date('2026-11-15T12:00:00.000Z');
  const base: Run = {
    id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
    projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
    provider: 'codex',
    task: 'x',
    state: 'waiting_for_operator',
    startCommit: 'a',
    remoteUrl: 'https://git.example.test/a.git',
    workingCopy: null,
    integrationBranch: 'dev',
    delivery: null,
    pullRequest: null,
    deliveryRequested: false,
    failingChecks: [],
    createdAt: at,
    startedAt: at,
    finishedAt: null,
    failure: null,
    claimedBy: null,
    limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
    cancelRequestedAt: null,
    cancellation: null,
    waitingSince: at,
    stepStartedAt: null,
    releasedBy: null,
    sessionRef: 'session-1',
    messages: [],
    environmentFileSupplied: false,
    environmentFilePath: null,
    lastClaimedBy: null,
    stepCount: 0,
    followUpCount: 0,
    followUpQueued: false,
    stepsBeforePart: 0,
    pushedCommit: null,
    workingCopyRemovedAt: null,
  };
  const question = { text: 'Which database?', options: ['PostgreSQL', 'SQLite'] };
  const asked: Run = { ...base, messages: [{ kind: 'question', question, at }] };
  const answered: Run = {
    ...base,
    state: 'queued',
    waitingSince: null,
    messages: [
      { kind: 'question', question, at },
      { kind: 'answer', text: 'PostgreSQL', at },
    ],
  };

  it('a queued Run with a session and an answer is resumable, with that answer', () => {
    expect(isResumable(answered)).toBe(true);
    expect(resumeAnswer(answered)).toBe('PostgreSQL');
    expect(isResumable({ ...answered, sessionRef: null })).toBe(false);
    expect(resumeAnswer({ ...answered, sessionRef: null })).toBeNull();
    expect(isResumable(asked)).toBe(false);
    expect(resumeAnswer(asked)).toBeNull();
    // Claimed to resume, it still carries the answer for the worker.
    const claimed: Run = { ...answered, state: 'preparing' };
    expect(resumeAnswer(claimed)).toBe('PostgreSQL');
    expect(isResumable(claimed)).toBe(false);
  });
});

// Issue #141: a Follow-up reopens a finished Run.
describe('Follow-ups', () => {
  const at = new Date('2026-11-16T12:00:00.000Z');
  const finished = {
    state: 'succeeded' as RunState,
    followUpQueued: false,
    claimedBy: null as string | null,
    deliveryRequested: false,
    sessionRef: 'session-1' as string | null,
    workingCopy: { runBranch: 'agent/x-r0b8e5c2d', commits: [], hasUncommittedChanges: false } as
      Run['workingCopy'] | null,
    workingCopyRemovedAt: null as Date | null,
    stepCount: 3,
    limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
  };
  const available = { workerAvailable: true, providerAvailable: true };

  it.each(['succeeded', 'failed', 'timed_out', 'cancelled'] as const)(
    'lets a finished Run (%s) with its session and Working copy take a Follow-up',
    (state) => {
      expect(followUpEligibility({ ...finished, state }, available)).toEqual({ allowed: true });
    },
  );

  it.each([
    ['not_finished', { state: 'running' as RunState }],
    ['not_finished', { state: 'waiting_for_operator' as RunState }],
    ['not_finished', { state: 'queued' as RunState }],
    ['not_finished', { state: 'failed' as RunState, deliveryRequested: true }],
    ['not_finished', { state: 'failed' as RunState, claimedBy: 'worker' }],
    ['follow_up_queued', { state: 'queued' as RunState, followUpQueued: true }],
    ['no_session', { sessionRef: null }],
    ['working_copy_removed', { workingCopy: null }],
    ['working_copy_removed', { workingCopyRemovedAt: at }],
    ['step_total_reached', { stepCount: 50 }],
  ] as const)('refuses with %s', (reason, patch) => {
    expect(followUpEligibility({ ...finished, ...patch }, available)).toEqual({
      allowed: false,
      reason,
    });
  });

  it('refuses while the agent worker holding the Working copy, or the Provider, is unavailable', () => {
    expect(
      followUpEligibility(finished, { workerAvailable: false, providerAvailable: true }),
    ).toEqual({ allowed: false, reason: 'worker_unavailable' });
    expect(
      followUpEligibility(finished, { workerAvailable: true, providerAvailable: false }),
    ).toEqual({ allowed: false, reason: 'provider_unavailable' });
  });

  it('resumes the session with the Follow-up, an answer or the usage-limit message, and says which', () => {
    const question = { kind: 'question' as const, question: { text: 'Which?' }, at };
    const answer = { kind: 'answer' as const, text: 'This one.', at };
    const followUp = { kind: 'follow_up' as const, text: 'Also add tests.', at };
    const resume = { kind: 'answer' as const, text: USAGE_LIMIT_RESUME_TEXT, at };
    const of = (messages: Run['messages']) => resumeMessage({ sessionRef: 'session-1', messages });

    expect(of([followUp])).toEqual({ text: 'Also add tests.', reason: 'follow_up' });
    expect(of([question, answer])).toEqual({ text: 'This one.', reason: 'answer' });
    expect(of([followUp, question, answer])).toEqual({ text: 'This one.', reason: 'answer' });
    expect(of([resume])).toEqual({ text: USAGE_LIMIT_RESUME_TEXT, reason: 'usage_limit' });
    expect(of([followUp, resume])).toEqual({
      text: USAGE_LIMIT_RESUME_TEXT,
      reason: 'usage_limit',
    });
    expect(of([followUp, question])).toBeNull();
    expect(resumeMessage({ sessionRef: null, messages: [followUp] })).toBeNull();
  });
});
