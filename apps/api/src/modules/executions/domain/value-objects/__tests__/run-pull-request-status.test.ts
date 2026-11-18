import { describe, expect, it } from 'vitest';
import { isEndedPullRequestState, PULL_REQUEST_STATES } from '../pull-request-state.js';
import { RunPullRequestStatus } from '../run-pull-request-status.js';
import { type StoredPullRequestStatus } from '../stored-pull-request-status.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const status = (patch: Partial<StoredPullRequestStatus> = {}) =>
  RunPullRequestStatus.restore({ ...RunPullRequestStatus.none().toStored(), ...patch });

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
    expect(after.toStored()).toMatchObject({
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
    expect(merged.toStored()).toMatchObject({
      state: 'merged',
      behindBy: null,
      aheadBy: null,
      mergeable: null,
      checks: null,
      refreshedAt: NOW,
      endedAt: NOW,
    });
    expect(open.observed('closed', NOW).toStored()).toMatchObject({
      state: 'closed',
      behindBy: 2,
      aheadBy: 1,
      mergeable: null,
      checks: null,
    });
  });

  it('keeps a failed lookup refreshing only while it has a retry', () => {
    expect(status().refreshFailed('x', later(30), NOW).toStored()).toMatchObject({
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
    expect(requested.toStored()).toMatchObject({
      prepareRequestedAt: NOW,
      prepareError: null,
      lastAttemptAt: ago(30),
    });
    expect(requested.preparationFailed('boom', null, NOW).toStored()).toMatchObject({
      prepareRequestedAt: null,
      prepareError: 'boom',
    });
    expect(requested.preparationDone().toStored()).toMatchObject({
      prepareRequestedAt: null,
      prepareError: null,
    });
    expect(status().refreshRequested(NOW).toStored()).toMatchObject({
      refreshRequestedAt: NOW,
      lastAttemptAt: NOW,
    });
  });
});
