import { describe, expect, it } from 'vitest';
import type { PullRequestRefreshFacts } from '../pull-request-refresh-facts.js';
import { PullRequestRefreshRule } from '../pull-request-refresh-rule.js';

describe('PullRequestRefreshRule', () => {
  const now = new Date('2026-11-18T12:00:00.000Z');

  it('refreshes pull requests older than a day', () => {
    expect(PullRequestRefreshRule.at(now).staleBefore).toEqual(
      new Date('2026-11-17T12:00:00.000Z'),
    );
  });

  it('takes the stale cutoff as given', () => {
    const cutoff = new Date('2026-11-17T12:00:00.000Z');
    expect(PullRequestRefreshRule.staleSince(cutoff).staleBefore).toEqual(cutoff);
  });

  it('keeps finished lookups for a week', () => {
    expect(PullRequestRefreshRule.at(now).finishedLookupsBefore).toEqual(
      new Date('2026-11-11T12:00:00.000Z'),
    );
  });

  describe('due daily', () => {
    const rule = PullRequestRefreshRule.at(now);
    const old = new Date('2026-11-17T11:59:59.000Z');
    const fresh = new Date('2026-11-17T12:00:00.000Z');
    const facts = (patch: Partial<PullRequestRefreshFacts>): PullRequestRefreshFacts => ({
      id: 'a',
      hasPullRequest: true,
      hasWorkingCopy: true,
      refreshRequestedAt: null,
      pullRequestState: 'open',
      lastAttemptAt: null,
      refreshedAt: null,
      ...patch,
    });

    it('takes an unread, draft or open pull request not attempted for a day', () => {
      expect(rule.dueDaily(facts({ pullRequestState: null }))).toBe(true);
      expect(rule.dueDaily(facts({ pullRequestState: 'draft', lastAttemptAt: old }))).toBe(true);
      expect(rule.dueDaily(facts({ lastAttemptAt: fresh }))).toBe(false);
    });

    it('counts from the last success only when no attempt was made', () => {
      expect(rule.dueDaily(facts({ refreshedAt: old }))).toBe(true);
      expect(rule.dueDaily(facts({ refreshedAt: old, lastAttemptAt: fresh }))).toBe(false);
    });

    it('leaves out ended pull requests, requested refreshes and Runs without a working copy', () => {
      expect(rule.dueDaily(facts({ pullRequestState: 'merged' }))).toBe(false);
      expect(rule.dueDaily(facts({ refreshRequestedAt: old }))).toBe(false);
      expect(rule.dueDaily(facts({ hasWorkingCopy: false }))).toBe(false);
      expect(rule.dueDaily(facts({ hasPullRequest: false }))).toBe(false);
    });

    it('orders by the oldest attempt, never attempted first, then by id', () => {
      const ordered = [
        facts({ id: 'c', lastAttemptAt: old }),
        facts({ id: 'b', lastAttemptAt: null }),
        facts({ id: 'a', lastAttemptAt: new Date(old.getTime() - 1) }),
        facts({ id: 'a2', lastAttemptAt: null }),
      ].sort((x, y) => rule.dailyOrder(x, y));
      expect(ordered.map((f) => f.id)).toEqual(['a2', 'b', 'a', 'c']);
    });
  });
});
