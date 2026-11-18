import { describe, expect, it } from 'vitest';
import { LookupHandOutRule, type LookupHandOutView } from '../lookup-hand-out-rule.js';
import { LOOKUP_CLAIM_MAX, LOOKUP_LEASE_SECONDS } from '../run-lookup.js';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const RUN = { id: 'r1', hasPullRequest: true, hasRunBranch: true };

const lookup = (id: string, patch: Partial<LookupHandOutView> = {}): LookupHandOutView => ({
  id,
  runId: 'r1',
  status: 'requested',
  requestedAt: ago(100),
  claimedAt: null,
  retryAt: null,
  ...patch,
});

describe('LookupHandOutRule', () => {
  const rule = LookupHandOutRule.at(NOW);

  it('uses the lease and the claim maximum of the domain unless told otherwise', () => {
    expect(rule).toMatchObject({ leaseSeconds: LOOKUP_LEASE_SECONDS, limit: LOOKUP_CLAIM_MAX });
    expect(LookupHandOutRule.at(NOW, { leaseSeconds: 5, limit: 2 })).toMatchObject({
      leaseSeconds: 5,
      limit: 2,
    });
  });

  it('hands out the oldest requests first, ties by id, at most the limit', () => {
    const lookups = [
      lookup('c', { requestedAt: ago(10) }),
      lookup('b', { requestedAt: ago(50) }),
      lookup('a', { requestedAt: ago(50) }),
      lookup('d', { requestedAt: ago(5) }),
    ];

    const handed = LookupHandOutRule.at(NOW, { limit: 3 }).next(lookups, [RUN]);

    expect(handed.map((candidate) => candidate.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves out lookups that are claimed, answered, waiting for a retry or without a pull request', () => {
    const lookups = [
      lookup('claimed', { status: 'claimed', claimedAt: ago(10) }),
      lookup('done', { status: 'done' }),
      lookup('failed', { status: 'failed' }),
      lookup('waiting', { retryAt: later(1) }),
      lookup('retry-due', { retryAt: ago(1) }),
      lookup('no-pr', { runId: 'r2' }),
      lookup('no-branch', { runId: 'r3' }),
    ];
    const runs = [
      RUN,
      { id: 'r2', hasPullRequest: false, hasRunBranch: true },
      { id: 'r3', hasPullRequest: true, hasRunBranch: false },
    ];

    expect(rule.next(lookups, runs).map((candidate) => candidate.id)).toEqual(['retry-due']);
  });

  it('takes a claim back to the queue once it is a lease old, and not before', () => {
    const edge = lookup('edge', { status: 'claimed', claimedAt: ago(LOOKUP_LEASE_SECONDS) });
    const fresh = lookup('fresh', { status: 'claimed', claimedAt: ago(LOOKUP_LEASE_SECONDS - 1) });

    expect(rule.claimExpired(edge)).toBe(true);
    expect(rule.claimExpired(fresh)).toBe(false);
    expect(rule.next([edge, fresh], [RUN]).map((candidate) => candidate.id)).toEqual(['edge']);
  });
});
