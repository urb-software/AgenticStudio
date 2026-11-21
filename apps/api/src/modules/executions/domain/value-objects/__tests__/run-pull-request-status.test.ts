import { describe, expect, it } from 'vitest';
import { isEndedPullRequestState, PULL_REQUEST_STATES } from '../pull-request-state.js';
import { RunPullRequestStatus } from '../run-pull-request-status.js';
import { type RunPullRequestStatusData } from '../run-pull-request-status-data.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const status = (patch: Partial<RunPullRequestStatusData> = {}) =>
  RunPullRequestStatus.restore({ ...RunPullRequestStatus.none().toData(), ...patch });

describe('RunPullRequestStatus.pageRefreshDue', () => {
  it('is due when the state was never read, or was read a minute ago or more', () => {
    expect(status().pageRefreshDue(NOW)).toBe(true);
    expect(status({ state: 'open', refreshedAt: ago(60) }).pageRefreshDue(NOW)).toBe(true);
  });

  it('is not due within a minute of the last read', () => {
    expect(status({ state: 'open', refreshedAt: ago(59) }).pageRefreshDue(NOW)).toBe(false);
  });

  it('counts from the last attempt: a failed lookup is not repeated on every open', () => {
    const failed = { refreshError: 'GitHub could not be reached.', lastAttemptAt: ago(30) };
    expect(status(failed).pageRefreshDue(NOW)).toBe(false);
    expect(status({ ...failed, lastAttemptAt: ago(60) }).pageRefreshDue(NOW)).toBe(true);
    expect(
      status({ state: 'open', refreshedAt: ago(3600), lastAttemptAt: ago(10) }).pageRefreshDue(NOW),
    ).toBe(false);
  });

  it('is not due while a refresh is under way, or a rate limit asks to wait', () => {
    expect(status({ refreshRequestedAt: ago(5) }).pageRefreshDue(NOW)).toBe(false);
    expect(status({ retryAt: later(30) }).pageRefreshDue(NOW)).toBe(false);
    expect(status({ retryAt: ago(1) }).pageRefreshDue(NOW)).toBe(true);
  });
});

describe('RunPullRequestStatus.hasFailedCheck', () => {
  const check = (state: 'passed' | 'failed' | 'running') => ({
    name: 'build',
    state,
    url: 'https://ci.test/1',
  });

  it('is true when a stored check failed', () => {
    expect(
      status({ checks: { commit: 'c'.repeat(40), checks: [check('passed'), check('failed')] } })
        .hasFailedCheck,
    ).toBe(true);
  });

  it('is false with no checks read, none failed, none listed or none told', () => {
    expect(status().hasFailedCheck).toBe(false);
    expect(
      status({ checks: { commit: 'c'.repeat(40), checks: [check('passed'), check('running')] } })
        .hasFailedCheck,
    ).toBe(false);
    expect(status({ checks: { commit: 'c'.repeat(40), checks: [] } }).hasFailedCheck).toBe(false);
    expect(status({ checks: { unavailable: true } }).hasFailedCheck).toBe(false);
  });
});

describe('RunPullRequestStatus.followUpRefusal and the ended states', () => {
  it('refuses a Follow-up for a merged, closed or missing pull request only', () => {
    expect(status({ state: 'merged' }).followUpRefusal).toBe('pull_request_merged');
    expect(status({ state: 'closed' }).followUpRefusal).toBe('pull_request_closed');
    expect(status({ state: 'missing' }).followUpRefusal).toBe('pull_request_missing');
    expect(status({ state: 'open' }).followUpRefusal).toBeNull();
    expect(status({ state: 'draft' }).followUpRefusal).toBeNull();
    expect(status().followUpRefusal).toBeNull();
  });

  it('knows which pull request states are an end', () => {
    expect(PULL_REQUEST_STATES.filter((state) => isEndedPullRequestState(state))).toEqual([
      'merged',
      'closed',
      'missing',
    ]);
    expect(isEndedPullRequestState(null)).toBe(false);
  });
});

describe('RunPullRequestStatus changes return a new status', () => {
  const read = { state: 'open' as const, behindBy: 2, aheadBy: 1, mergeable: true };

  it('keeps what it was and replaces only what a lookup read', () => {
    const before = status({ refreshError: 'old', retryAt: later(30), refreshRequestedAt: ago(5) });
    const after = before.read(read, NOW);

    expect(after).not.toBe(before);
    expect(before.state).toBeNull();
    expect(after.toData()).toMatchObject({
      state: 'open',
      behindBy: 2,
      aheadBy: 1,
      mergeable: true,
      refreshedAt: NOW,
      refreshError: null,
      retryAt: null,
      refreshRequestedAt: null,
      checks: null,
      endedAt: null,
    });
  });

  it('keeps the first time it was read as over, and a reopened pull request clears it', () => {
    const ended = status().read({ state: 'merged' }, ago(3600));
    expect(ended.endedAt).toEqual(ago(3600));
    expect(ended.read({ state: 'merged' }, NOW).endedAt).toEqual(ago(3600));
    expect(ended.read({ state: 'open' }, NOW).endedAt).toBeNull();
  });

  it('takes the checks a lookup read, or that the host refused to tell them', () => {
    const checks = [{ name: 'build', state: 'failed' as const, url: 'https://ci.test/1' }];
    expect(status().read({ ...read, checksCommit: 'c'.repeat(40), checks }, NOW).checks).toEqual({
      commit: 'c'.repeat(40),
      checks,
    });
    expect(status().read({ ...read, checksUnavailable: true }, NOW).checks).toEqual({
      unavailable: true,
    });
  });

  it('clears the position, verdict and checks of a pull request seen as over', () => {
    const open = status().read({ ...read, checksCommit: 'c'.repeat(40), checks: [] }, ago(60));
    const merged = open.observed('merged', NOW);
    expect(merged.toData()).toMatchObject({
      state: 'merged',
      behindBy: null,
      aheadBy: null,
      mergeable: null,
      checks: null,
      refreshedAt: NOW,
      endedAt: NOW,
    });
    expect(open.observed('closed', NOW).toData()).toMatchObject({
      state: 'closed',
      behindBy: 2,
      aheadBy: 1,
      mergeable: null,
      checks: null,
    });
  });

  it('keeps a failed lookup refreshing only while it has a retry', () => {
    expect(status().refreshFailed('x', later(30), NOW).toData()).toMatchObject({
      refreshError: 'x',
      retryAt: later(30),
      refreshRequestedAt: NOW,
    });
    expect(
      status({ refreshRequestedAt: ago(5) }).refreshFailed('x', null, NOW).refreshRequestedAt,
    ).toBeNull();
  });

  it('tracks the preparation of failing checks apart from the refresh', () => {
    const requested = status({ lastAttemptAt: ago(30) }).preparationRequested(NOW);
    expect(requested.toData()).toMatchObject({
      prepareRequestedAt: NOW,
      prepareError: null,
      lastAttemptAt: ago(30),
    });
    expect(requested.preparationFailed('boom', null, NOW).toData()).toMatchObject({
      prepareRequestedAt: null,
      prepareError: 'boom',
    });
    expect(requested.preparationDone().toData()).toMatchObject({
      prepareRequestedAt: null,
      prepareError: null,
    });
    expect(status().refreshRequested(NOW).toData()).toMatchObject({
      refreshRequestedAt: NOW,
      lastAttemptAt: NOW,
    });
  });
});

describe('RunPullRequestStatus.refreshOutcome', () => {
  it('is idle without a refresh asked for, whatever the worker', () => {
    expect(status().refreshOutcome()).toBe('idle');
    expect(status().refreshOutcome(false)).toBe('idle');
  });

  it('is refreshing while asked for, also when the worker connection is unknown', () => {
    const waiting = status({ refreshRequestedAt: ago(5) });
    expect(waiting.refreshOutcome()).toBe('refreshing');
    expect(waiting.refreshOutcome(true)).toBe('refreshing');
  });

  it('is no_worker when a refresh is asked for and no worker is connected', () => {
    expect(status({ refreshRequestedAt: ago(5) }).refreshOutcome(false)).toBe('no_worker');
  });
});

describe('RunPullRequestStatus.preparationOutcome', () => {
  it('is none when nothing was asked for, failed, or prepared', () => {
    expect(status().preparationOutcome(true, false)).toBeNull();
  });

  it('is preparing while asked for, or no_worker when no worker is connected', () => {
    const waiting = status({ prepareRequestedAt: ago(5) });
    expect(waiting.preparationOutcome(true, false)).toBe('preparing');
    expect(waiting.preparationOutcome(undefined, false)).toBe('preparing');
    expect(waiting.preparationOutcome(false, false)).toBe('no_worker');
  });

  it('is failed with an error, and ready with a prepared Follow-up', () => {
    expect(status({ prepareError: 'The log is gone.' }).preparationOutcome(true, false)).toBe(
      'failed',
    );
    expect(status().preparationOutcome(true, true)).toBe('ready');
  });

  it('is failed rather than ready when both an error and a prepared Follow-up exist', () => {
    expect(status({ prepareError: 'x' }).preparationOutcome(true, true)).toBe('failed');
  });
});

describe('RunPullRequestStatus.checksOnOtherCommit', () => {
  const COMMIT = 'c'.repeat(40);
  const read = status({ state: 'open', checks: { commit: COMMIT, checks: [] } });

  it('is true when the checks belong to another commit than the pushed one', () => {
    expect(read.checksOnOtherCommit('d'.repeat(40))).toBe(true);
  });

  it('ignores letter case, and is false for the same commit', () => {
    expect(read.checksOnOtherCommit(COMMIT.toUpperCase())).toBe(false);
  });

  it('is false without a pushed commit, without checks, or when GitHub would not tell them', () => {
    expect(read.checksOnOtherCommit(null)).toBe(false);
    expect(status().checksOnOtherCommit(COMMIT)).toBe(false);
    expect(status({ checks: { unavailable: true } }).checksOnOtherCommit(COMMIT)).toBe(false);
  });
});

describe('RunPullRequestStatus closing from Studio', () => {
  it('claims the close, and refuses a second claim until the first goes stale', () => {
    const claimed = status({ state: 'open' }).closeClaimed(NOW);
    expect(claimed.closeClaimedAt).toEqual(NOW);
    expect(claimed.isCloseClaimed(later(119))).toBe(true);
    expect(claimed.isCloseClaimed(later(120))).toBe(false);
    expect(claimed.closeReleased().closeClaimedAt).toBeNull();
  });

  it('records the close as a fresh closed state that starts retention, keeping the claim', () => {
    const closed = status({ state: 'open', mergeable: true, closeClaimedAt: NOW }).closedFromStudio(
      later(5),
    );
    expect(closed).toMatchObject({
      state: 'closed',
      refreshedAt: later(5),
      endedAt: later(5),
      closedFromStudioAt: later(5),
      mergeable: null,
      closeClaimedAt: NOW,
    });
  });

  it('goes from not closed, to the branch pending, to complete', () => {
    const closed = status({ state: 'open' }).closedFromStudio(NOW);
    expect(status({ state: 'open' }).closeProgress).toBe('not_closed');
    expect(closed.closeProgress).toBe('branch_pending');
    expect(closed.branchDeleted(later(1)).closeProgress).toBe('complete');
  });

  it('clears the claim and an earlier failure when the branch is deleted', () => {
    const failed = status({ closeClaimedAt: NOW, runBranchDeletionFailure: 'Earlier.' });
    expect(failed.branchDeleted(later(1))).toMatchObject({
      runBranchDeletedAt: later(1),
      runBranchDeletionFailure: null,
      closeClaimedAt: null,
    });
  });

  it('keeps the close and a redacted failure of at most 500 characters when the deletion fails', () => {
    const failed = status({ closedFromStudioAt: NOW, closeClaimedAt: NOW }).branchDeletionFailed(
      'x'.repeat(600),
    );
    expect(failed.closedFromStudioAt).toEqual(NOW);
    expect(failed.closeClaimedAt).toBeNull();
    expect(failed.runBranchDeletionFailure).toHaveLength(500);
    expect(failed.closeProgress).toBe('branch_pending');
  });
});
