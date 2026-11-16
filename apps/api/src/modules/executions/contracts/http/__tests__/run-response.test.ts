import { describe, expect, it } from 'vitest';
import { runResponseSchema, toRunListItem, toRunResponse } from '../run-response.js';

// Issue #103: the conversation and the open question in the operator API.
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T12:05:00.000Z');
const T2 = new Date('2026-11-15T12:10:00.000Z');
const QUESTION = {
  text: 'Which database?',
  options: ['PostgreSQL', 'SQLite'],
  recommendation: 'PostgreSQL',
};

const run = {
  id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'codex' as const,
  task: 'Add a store',
  state: 'waiting_for_operator' as const,
  startCommit: 'a'.repeat(40),
  createdAt: T0,
  startedAt: T0,
  finishedAt: null,
  failure: null,
  workingCopy: null,
  limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
  stepCount: 1,
  stepsBeforePart: 0,
  followUpCount: 0,
  pushedCommit: null as string | null,
  cancelRequestedAt: null,
  cancellation: null,
  delivery: null,
  pullRequest: null,
  deliveryRequested: false,
  failingChecks: [],
  environmentFileSupplied: false,
  sessionRef: 'session-1' as string | null,
  messages: [{ kind: 'question' as const, question: QUESTION, at: T1 }] as Parameters<
    typeof toRunResponse
  >[0]['messages'],
};

describe('Run response: conversation (Issue #103)', () => {
  it('shows the open question of a waiting Run, with its options and recommendation', () => {
    const response = runResponseSchema.parse(toRunResponse(run));

    expect(response.question).toEqual(QUESTION);
    expect(response.messages).toEqual([
      { role: 'operator', kind: 'task', text: 'Add a store', at: T0.toISOString() },
      {
        role: 'agent',
        kind: 'question',
        text: 'Which database?',
        // Review M2 of #127: a past question keeps its options and recommendation.
        options: ['PostgreSQL', 'SQLite'],
        recommendation: 'PostgreSQL',
        at: T1.toISOString(),
      },
    ]);
  });

  it('lists the answer after its question, and no open question once answered', () => {
    const response = toRunResponse({
      ...run,
      state: 'queued',
      messages: [...run.messages, { kind: 'answer', text: 'PostgreSQL', at: T2 }],
    });

    expect(response.question).toBeUndefined();
    expect(response.messages?.map(({ role, kind, text }) => [role, kind, text])).toEqual([
      ['operator', 'task', 'Add a store'],
      ['agent', 'question', 'Which database?'],
      ['operator', 'answer', 'PostgreSQL'],
    ]);
  });

  it('leaves the conversation and the open question out of list items (coordinator decision)', () => {
    const item = toRunListItem(run);

    expect(item).not.toHaveProperty('messages');
    expect(item).not.toHaveProperty('question');
    expect(item).toMatchObject({ id: run.id, state: 'waiting_for_operator' });
  });

  it('has no open question outside waiting, and the Task alone before any question', () => {
    expect(toRunResponse({ ...run, state: 'cancelled' }).question).toBeUndefined();
    expect(toRunResponse({ ...run, state: 'running', messages: [] }).messages).toEqual([
      { role: 'operator', kind: 'task', text: 'Add a store', at: T0.toISOString() },
    ]);
  });
});

describe('Run response: resuming after the usage limit (Issue #105)', () => {
  const stopped = {
    ...run,
    state: 'failed' as const,
    finishedAt: T2,
    failure: { code: 'usage_limit' as const, detail: 'The usage limit was reached.' },
    workingCopy: { runBranch: 'agent/x', commits: [], hasUncommittedChanges: false },
    messages: [],
  };

  it('says a Run stopped at the usage limit with a session can be resumed', () => {
    expect(runResponseSchema.parse(toRunResponse(stopped)).resumable).toBe(true);
  });

  it.each([
    ['another failure', { failure: { code: 'agent_failed' as const, detail: 'x' } }],
    ['no session', { sessionRef: null }],
    ['no Working copy', { workingCopy: null }],
    ['a cancel request', { cancelRequestedAt: T2 }],
  ])('not with %s', (_case, change) => {
    expect(toRunResponse({ ...stopped, ...change })).not.toHaveProperty('resumable');
  });
});

// Issue #141: Follow-ups in the operator API.
describe('Run response: Follow-ups (Issue #141)', () => {
  const C1 = 'c'.repeat(40);
  const C2 = 'd'.repeat(40);
  const C3 = 'e'.repeat(40);
  const followedUp = {
    ...run,
    state: 'running' as const,
    workingCopy: {
      runBranch: 'agent/x-r0b8e5c2d',
      commits: [
        { id: C1, subject: 'First' },
        { id: C2, subject: 'Second' },
        { id: C3, subject: 'Third' },
      ],
      hasUncommittedChanges: false,
    },
    pullRequest: { url: 'https://github.com/acme/shop/pull/7', number: 7 },
    pushedCommit: C2 as string | null,
    stepCount: 4,
    stepsBeforePart: 3,
    followUpCount: 1,
    messages: [{ kind: 'follow_up' as const, text: 'Also add tests.', at: T2 }],
  };

  it('marks the commits up to the pushed one as pushed, later ones as only in the Working copy', () => {
    const response = runResponseSchema.parse(toRunResponse(followedUp));
    expect(response.commits).toEqual([
      { id: C1, subject: 'First', pushed: true },
      { id: C2, subject: 'Second', pushed: true },
      { id: C3, subject: 'Third', pushed: false },
    ]);
    expect(
      toRunResponse({ ...followedUp, pushedCommit: null }).commits?.map((c) => c.pushed),
    ).toEqual([false, false, false]);
  });

  it('shows the Follow-up in the conversation, the step totals, the count and the kept pull request', () => {
    const response = runResponseSchema.parse(toRunResponse(followedUp));
    expect(response.messages?.at(-1)).toEqual({
      role: 'operator',
      kind: 'follow_up',
      text: 'Also add tests.',
      at: T2.toISOString(),
    });
    expect(response.steps).toEqual({ used: 4, usedInPart: 1 });
    expect(response.limits.maxTotalSteps).toBe(50);
    expect(response.followUps).toBe(1);
    expect(response.pullRequest).toEqual({ url: 'https://github.com/acme/shop/pull/7', number: 7 });
    expect(toRunListItem(followedUp).followUps).toBe(1);
  });

  it('carries the eligibility only when given: allowed, or refused with the reason', () => {
    expect(toRunResponse(followedUp).followUp).toBeUndefined();
    expect(toRunResponse(followedUp, { allowed: true }).followUp).toEqual({ allowed: true });
    const refused = runResponseSchema.parse(
      toRunResponse(followedUp, { allowed: false, reason: 'step_total_reached' }),
    );
    expect(refused.followUp).toEqual({ allowed: false, reason: 'step_total_reached' });
  });
});
