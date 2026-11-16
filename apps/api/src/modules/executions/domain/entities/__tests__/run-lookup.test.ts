import { describe, expect, it } from 'vitest';
import { NO_PULL_REQUEST_STATUS, type RunPullRequestStatus } from '../run.js';
import {
  canRefreshPullRequest,
  STORED_RETRY_DELAY_MAX_SECONDS,
  pageRefreshDue,
  retryDelaySeconds,
} from '../run-lookup.js';

// Issue #142: when a pull request state is looked up, and when a lookup is retried.
const NOW = new Date('2026-11-16T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const status = (patch: Partial<RunPullRequestStatus>) => ({
  pullRequestStatus: { ...NO_PULL_REQUEST_STATUS, ...patch },
});

describe('pageRefreshDue', () => {
  it('is due when the state was never read, or was read a minute ago or more', () => {
    expect(pageRefreshDue(status({}), NOW)).toBe(true);
    expect(pageRefreshDue(status({ state: 'open', refreshedAt: ago(60) }), NOW)).toBe(true);
  });

  it('is not due within a minute of the last read', () => {
    expect(pageRefreshDue(status({ state: 'open', refreshedAt: ago(59) }), NOW)).toBe(false);
  });

  it('counts from the last attempt: a failed lookup is not repeated on every open (review S1 of #152)', () => {
    const failed = { refreshError: 'GitHub could not be reached.', lastAttemptAt: ago(30) };
    expect(pageRefreshDue(status(failed), NOW)).toBe(false);
    expect(pageRefreshDue(status({ ...failed, lastAttemptAt: ago(60) }), NOW)).toBe(true);
    // An old success does not make a recent failed attempt due.
    expect(
      pageRefreshDue(
        status({ state: 'open', refreshedAt: ago(3600), lastAttemptAt: ago(10) }),
        NOW,
      ),
    ).toBe(false);
  });

  it('is not due while a refresh is under way, or a rate limit asks to wait', () => {
    expect(pageRefreshDue(status({ refreshRequestedAt: ago(5) }), NOW)).toBe(false);
    expect(pageRefreshDue(status({ retryAt: later(30) }), NOW)).toBe(false);
    expect(pageRefreshDue(status({ retryAt: ago(1) }), NOW)).toBe(true);
  });
});

describe('retryDelaySeconds', () => {
  it('retries only a rate limit, after what the Git host asked, bounded', () => {
    expect(retryDelaySeconds({ code: 'rate_limited', error: 'x', retryAfterSeconds: 90 })).toBe(90);
    expect(retryDelaySeconds({ code: 'rate_limited', error: 'x' })).toBe(60);
    expect(
      retryDelaySeconds({ code: 'rate_limited', error: 'x', retryAfterSeconds: 999_999 }),
    ).toBe(STORED_RETRY_DELAY_MAX_SECONDS);
    expect(retryDelaySeconds({ code: 'failed', error: 'x' })).toBeNull();
    expect(retryDelaySeconds({ code: 'scope_mismatch', error: 'x' })).toBeNull();
  });
});

describe('canRefreshPullRequest', () => {
  it('needs a pull request and the Run branch', () => {
    const pullRequest = { url: 'https://github.com/a/b/pull/1', number: 1 };
    const workingCopy = { runBranch: 'agent/x-r1', commits: [], hasUncommittedChanges: false };
    expect(canRefreshPullRequest({ pullRequest, workingCopy })).toBe(true);
    expect(canRefreshPullRequest({ pullRequest: null, workingCopy })).toBe(false);
    expect(canRefreshPullRequest({ pullRequest, workingCopy: null })).toBe(false);
  });
});
