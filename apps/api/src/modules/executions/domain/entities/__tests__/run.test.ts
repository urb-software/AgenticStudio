import { describe, expect, it } from 'vitest';
import { Run } from '../run.js';
import { type RestoreData } from '../../../../../__tests__/restore-data.js';
import { RunPullRequestStatus } from '../../value-objects/run-pull-request-status.js';
import type { RunState } from '../../value-objects/run-state.js';
import { LongWaitRule } from '../../value-objects/long-wait-rule.js';
import { AT, runData } from './run-fixtures.js';

describe('long-wait rule', () => {
  const since = new Date('2026-11-01T12:00:00.000Z');
  const waiting = (
    waitingDays: number,
    overrides: Partial<RestoreData<typeof Run>> = {},
  ): RestoreData<typeof Run> =>
    runData({
      createdAt: since,
      startedAt: since,
      waitingSince: since,
      lastActivityAt: since,
      sessionRef: null,
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays, maxTotalSteps: 50 },
      ...overrides,
    });
  const after = (days: number, extraMs = 0) =>
    new Date(since.getTime() + days * 24 * 60 * 60 * 1000 + extraMs);

  it('leaves a Run waiting exactly its limit alone', () => {
    expect(LongWaitRule.at(after(14)).cancellationFor(waiting(14))).toBeNull();
  });

  it('cancels a Run waiting longer than its limit, by the system, saying why', () => {
    expect(LongWaitRule.at(after(14, 1)).cancellationFor(waiting(14))).toEqual({
      by: 'system',
      reason: 'Cancelled automatically: the run waited for the operator longer than 14 days.',
    });
    expect(LongWaitRule.at(after(2)).cancellationFor(waiting(1))?.reason).toBe(
      'Cancelled automatically: the run waited for the operator longer than 1 day.',
    );
  });

  it('applies only to a Run waiting for the operator', () => {
    expect(
      LongWaitRule.at(after(30)).cancellationFor(
        waiting(1, { state: 'running', waitingSince: null }),
      ),
    ).toBeNull();
  });
});

describe('questions and answers', () => {
  const question = { text: 'Which database?', options: ['PostgreSQL', 'SQLite'] };
  const asked = runData({ messages: [{ kind: 'question', question, at: AT }] });
  const answered = runData({
    state: 'queued',
    waitingSince: null,
    messages: [
      { kind: 'question', question, at: AT },
      { kind: 'answer', text: 'PostgreSQL', at: AT },
    ],
  });

  it('a queued Run with a session and an answer is resumable, with that answer', () => {
    expect(Run.restore(answered).isResumable).toBe(true);
    expect(Run.restore(answered).resumeMessage()).toEqual({ text: 'PostgreSQL', reason: 'answer' });
    expect(Run.restore({ ...answered, sessionRef: null }).isResumable).toBe(false);
    expect(Run.restore({ ...answered, sessionRef: null }).resumeMessage()).toBeNull();
    expect(Run.restore(asked).isResumable).toBe(false);
    expect(Run.restore(asked).resumeMessage()).toBeNull();
    const claimed = { ...answered, state: 'preparing' as const };
    expect(Run.restore(claimed).resumeMessage()?.text).toBe('PostgreSQL');
    expect(Run.restore(claimed).isResumable).toBe(false);
  });
});

describe('Follow-ups', () => {
  const finished = runData({
    state: 'succeeded',
    waitingSince: null,
    workingCopy: { runBranch: 'agent/x-r0b8e5c2d', commits: [], hasUncommittedChanges: false },
    stepCount: 3,
  });
  const restored = (patch: Partial<RestoreData<typeof Run>> = {}) => {
    const state = patch.state ?? finished.state;
    return Run.restore({
      ...finished,
      ...(state === 'failed' ? { failure: { code: 'agent_failed' as const, detail: 'x' } } : {}),
      ...(state === 'cancelled'
        ? { cancellation: { by: 'operator' as const, reason: 'Cancelled by the operator.' } }
        : {}),
      ...patch,
    });
  };
  const available = { workerAvailable: true, providerAvailable: true };
  const known = (state: NonNullable<RestoreData<typeof Run>['pullRequestStatus']['state']>) => ({
    ...RunPullRequestStatus.none().toData(),
    state,
    refreshedAt: AT,
  });

  it.each(['draft', 'open'] as const)(
    'lets a Run whose pull request is %s take a Follow-up',
    (state) => {
      expect(restored({ pullRequestStatus: known(state) }).followUpEligibility(available)).toEqual({
        allowed: true,
      });
    },
  );

  it('allows a Follow-up when the pull request state is unknown, and again once it is reopened', () => {
    expect(restored().followUpEligibility(available)).toEqual({ allowed: true });
    expect(restored({ pullRequestStatus: known('closed') }).followUpEligibility(available)).toEqual(
      { allowed: false, reason: 'pull_request_closed' },
    );
    expect(restored({ pullRequestStatus: known('open') }).followUpEligibility(available)).toEqual({
      allowed: true,
    });
  });

  it('keeps the last known state when a lookup failed', () => {
    const failed = restored({
      pullRequestStatus: { ...known('merged'), refreshError: 'GitHub could not be reached.' },
    });
    expect(failed.followUpEligibility(available)).toEqual({
      allowed: false,
      reason: 'pull_request_merged',
    });
  });

  it.each(['succeeded', 'failed', 'timed_out', 'cancelled'] as const)(
    'lets a finished Run (%s) with its session and Working copy take a Follow-up',
    (state) => {
      expect(restored({ state }).followUpEligibility(available)).toEqual({ allowed: true });
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
    ['working_copy_removed', { workingCopyRemovedAt: AT }],
    ['step_total_reached', { stepCount: 50 }],
    ['pull_request_merged', { pullRequestStatus: known('merged') }],
    ['pull_request_closed', { pullRequestStatus: known('closed') }],
    ['pull_request_missing', { pullRequestStatus: known('missing') }],
  ] as const)('refuses with %s', (reason, patch) => {
    expect(restored(patch).followUpEligibility(available)).toEqual({ allowed: false, reason });
  });

  it('refuses while the agent worker holding the Working copy, or the Provider, is unavailable', () => {
    expect(
      restored().followUpEligibility({ workerAvailable: false, providerAvailable: true }),
    ).toEqual({ allowed: false, reason: 'worker_unavailable' });
    expect(
      restored().followUpEligibility({ workerAvailable: true, providerAvailable: false }),
    ).toEqual({ allowed: false, reason: 'provider_unavailable' });
  });

  it('can refresh the pull request only with one and a known Run branch', () => {
    const pullRequest = { url: 'https://github.com/a/b/pull/1', number: 1 };
    const workingCopy = { runBranch: 'agent/x-r1', commits: [], hasUncommittedChanges: false };
    expect(restored({ pullRequest, workingCopy }).canRefreshPullRequest()).toBe(true);
    expect(restored({ pullRequest: null, workingCopy }).canRefreshPullRequest()).toBe(false);
    expect(restored({ pullRequest, workingCopy: null }).canRefreshPullRequest()).toBe(false);
  });
});
