import { describe, expect, it } from 'vitest';
import {
  NO_WORKER_FOR_REFRESH,
  runResponseSchema,
  toRunListItem,
  toRunResponse,
} from '../run-response.js';

const NO_PULL_REQUEST_STATUS: Parameters<typeof toRunResponse>[0]['pullRequestStatus'] = {
  state: null,
  behindBy: null,
  aheadBy: null,
  mergeable: null,
  refreshedAt: null,
  refreshError: null,
  retryAt: null,
  refreshRequestedAt: null,
  checks: null,
  prepareRequestedAt: null,
  prepareError: null,
  preparedFollowUp: false,
};

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
  pullRequestStatus: NO_PULL_REQUEST_STATUS,
  deliveryRequested: false,
  failingChecks: [],
  environmentFileSupplied: false,
  sessionRef: 'session-1' as string | null,
  messages: [{ kind: 'question' as const, question: QUESTION, at: T1 }] as Parameters<
    typeof toRunResponse
  >[0]['messages'],
};

describe('Run response: conversation', () => {
  it('shows the open question of a waiting Run, with its options and recommendation', () => {
    const response = runResponseSchema.parse(toRunResponse(run));

    expect(response.question).toEqual(QUESTION);
    expect(response.messages).toEqual([
      { role: 'operator', kind: 'task', text: 'Add a store', at: T0.toISOString() },
      {
        role: 'agent',
        kind: 'question',
        text: 'Which database?',
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

describe('Run response: resuming after the usage limit', () => {
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

describe('Run response: Follow-ups', () => {
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

  it('leaves the pushed state unknown when the pushed commit is not listed', () => {
    const response = runResponseSchema.parse(
      toRunResponse({ ...followedUp, pushedCommit: 'f'.repeat(40) }),
    );
    expect(response.commits?.every((commit) => !('pushed' in commit))).toBe(true);
  });

  it("shows a part's end as Studio's record", () => {
    const response = runResponseSchema.parse(
      toRunResponse({
        ...followedUp,
        messages: [
          {
            kind: 'part_end',
            state: 'cancelled',
            failureCode: null,
            delivery: null,
            detail: 'Cancelled by the operator.',
            at: T1,
          },
          { kind: 'follow_up', text: 'Also add tests.', at: T2 },
        ],
      }),
    );
    expect(response.messages?.[1]).toEqual({
      role: 'studio',
      kind: 'part_end',
      text: 'Cancelled by the operator.',
      end: { state: 'cancelled' },
      at: T1.toISOString(),
    });
  });

  it('carries the eligibility only when given: allowed, or refused with the reason', () => {
    expect(toRunResponse(followedUp).followUp).toBeUndefined();
    expect(toRunResponse(followedUp, { allowed: true }).followUp).toEqual({ allowed: true });
    const refused = runResponseSchema.parse(
      toRunResponse(followedUp, { allowed: false, reason: 'step_total_reached' }),
    );
    expect(refused.followUp).toEqual({ allowed: false, reason: 'step_total_reached' });
  });

  it('says until when the Run is open to Follow-ups, when it is', () => {
    const open = runResponseSchema.parse(
      toRunResponse(followedUp, { allowed: true, openUntil: T2 }),
    );
    expect(open.followUp).toEqual({ allowed: true, openUntil: T2.toISOString() });
    const waiting = runResponseSchema.parse(
      toRunResponse(followedUp, { allowed: false, reason: 'worker_unavailable', openUntil: T2 }),
    );
    expect(waiting.followUp).toEqual({
      allowed: false,
      reason: 'worker_unavailable',
      openUntil: T2.toISOString(),
    });
  });
});

describe('Run response: pull request state', () => {
  const REFRESHED = new Date('2026-11-16T12:00:00.000Z');
  const withPullRequest = (status: Partial<typeof NO_PULL_REQUEST_STATUS>) => ({
    ...run,
    pullRequest: { url: 'https://github.com/acme/shop/pull/7', number: 7 },
    pullRequestStatus: { ...NO_PULL_REQUEST_STATUS, ...status },
  });

  it('carries only the number and link until a lookup succeeded', () => {
    const response = runResponseSchema.parse(toRunResponse(withPullRequest({})));
    expect(response.pullRequest).toEqual({
      url: 'https://github.com/acme/shop/pull/7',
      number: 7,
    });
  });

  it('shows the state, the branch position, the merge verdict and when it was read', () => {
    const response = runResponseSchema.parse(
      toRunResponse(
        withPullRequest({
          state: 'draft',
          behindBy: 2,
          aheadBy: 3,
          mergeable: false,
          refreshedAt: REFRESHED,
        }),
      ),
    );
    expect(response.pullRequest).toEqual({
      url: 'https://github.com/acme/shop/pull/7',
      number: 7,
      state: 'draft',
      behindBy: 2,
      aheadBy: 3,
      mergeable: false,
      refreshedAt: '2026-11-16T12:00:00.000Z',
    });
  });

  it('keeps the last known state next to why the latest refresh failed, and when it retries', () => {
    const retryAt = new Date('2026-11-16T12:05:00.000Z');
    const response = runResponseSchema.parse(
      toRunResponse(
        withPullRequest({
          state: 'open',
          refreshedAt: REFRESHED,
          refreshError: 'GitHub asked to wait.',
          retryAt,
          refreshRequestedAt: REFRESHED,
        }),
      ),
    );
    expect(response.pullRequest).toMatchObject({
      state: 'open',
      refreshError: 'GitHub asked to wait.',
      retryAt: '2026-11-16T12:05:00.000Z',
      refreshing: true,
    });
  });

  it('says a waiting refresh is under way, or that no agent worker is connected to carry it out', () => {
    const waiting = withPullRequest({ state: 'open', refreshRequestedAt: REFRESHED });
    expect(toRunResponse(waiting).pullRequest?.refreshing).toBe(true);
    expect(toRunResponse(waiting, undefined, true).pullRequest?.refreshing).toBe(true);
    const noWorker = toRunResponse(waiting, undefined, false).pullRequest;
    expect(noWorker?.refreshing).toBeUndefined();
    expect(noWorker?.refreshError).toBe(NO_WORKER_FOR_REFRESH);
    expect(
      toRunResponse(withPullRequest({ state: 'open' }), undefined, false).pullRequest?.refreshError,
    ).toBeUndefined();
  });

  describe('Pull request checks', () => {
    const COMMIT = 'c'.repeat(40);
    const checks = [
      { name: 'build', state: 'passed' as const, durationSeconds: 61, url: 'https://ci.test/1' },
      { name: 'lint', state: 'failed' as const, url: 'https://ci.test/2' },
    ];
    const read = (status: Parameters<typeof withPullRequest>[0], pushedCommit: string | null) =>
      runResponseSchema.parse(toRunResponse({ ...withPullRequest(status), pushedCommit }))
        .pullRequest!;

    it('lists the checks with their commit, and nothing before they were read', () => {
      expect(read({}, null)).not.toHaveProperty('checks');
      expect(read({ state: 'open', checks: { commit: COMMIT, checks } }, COMMIT)).toMatchObject({
        checksCommit: COMMIT,
        checks,
      });
      expect(read({ state: 'open', checks: { commit: COMMIT, checks: [] } }, COMMIT)).toMatchObject(
        { checksCommit: COMMIT, checks: [] },
      );
    });

    it('says when GitHub would not tell the checks', () => {
      const card = read({ state: 'open', checks: { unavailable: true } }, COMMIT);

      expect(card.checksUnavailable).toBe(true);
      expect(card).not.toHaveProperty('checks');
    });

    it("says when the checks belong to another commit than the Run's latest pushed one", () => {
      const status = { state: 'open' as const, checks: { commit: COMMIT, checks } };

      expect(read(status, COMMIT.toUpperCase())).not.toHaveProperty('checksOtherCommit');
      expect(read(status, 'd'.repeat(40)).checksOtherCommit).toBe(true);
      expect(read(status, null)).not.toHaveProperty('checksOtherCommit');
    });

    it('shows where the preparation of the failing checks stands', () => {
      const failed = { name: 'lint', state: 'failed' as const, url: 'https://ci.test/2' };
      const base = { state: 'open' as const, checks: { commit: COMMIT, checks: [failed] } };

      expect(read(base, COMMIT)).not.toHaveProperty('failingChecksPreparation');
      expect(
        read({ ...base, prepareRequestedAt: REFRESHED }, COMMIT).failingChecksPreparation,
      ).toEqual({ state: 'preparing' });
      expect(read({ ...base, preparedFollowUp: true }, COMMIT).failingChecksPreparation).toEqual({
        state: 'ready',
      });
      expect(
        read({ ...base, prepareError: 'The log is gone.' }, COMMIT).failingChecksPreparation,
      ).toEqual({ state: 'failed', error: 'The log is gone.' });
    });

    it('says no agent worker is connected instead of preparing for ever', () => {
      const waiting = { ...withPullRequest({ state: 'open', prepareRequestedAt: REFRESHED }) };

      expect(
        toRunResponse(waiting, undefined, false).pullRequest?.failingChecksPreparation,
      ).toEqual({ state: 'failed', error: expect.stringContaining('not connected') });
      expect(toRunResponse(waiting, undefined, true).pullRequest?.failingChecksPreparation).toEqual(
        { state: 'preparing' },
      );
    });

    it('marks a Follow-up message that was prepared from checks', () => {
      const answer = toRunResponse({
        ...withPullRequest({}),
        messages: [
          { kind: 'follow_up', text: 'Fix it.', at: REFRESHED, source: 'pull_request_checks' },
          { kind: 'follow_up', text: 'Also this.', at: REFRESHED },
        ],
      });

      const [, prepared, written] = answer.messages!;
      expect(prepared).toMatchObject({ kind: 'follow_up', source: 'pull_request_checks' });
      expect(written).not.toHaveProperty('source');
    });
  });

  it('shows the state in a list too, and leaves a Run without a pull request alone', () => {
    expect(
      toRunListItem(withPullRequest({ state: 'merged', refreshedAt: REFRESHED })).pullRequest
        ?.state,
    ).toBe('merged');
    expect(toRunResponse(run).pullRequest).toBeUndefined();
  });
});
