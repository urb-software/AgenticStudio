import { describe, expect, it } from 'vitest';
import type { LimitedRunFacts } from '../limited-run-facts.js';
import { RetentionPolicy } from '../retention-policy.js';

const policy = RetentionPolicy.of({
  days: 7,
  maxPerProject: 5,
  openPullRequestIdleDays: 14,
  hoursAfterPullRequestEnd: 24,
});
const counted: LimitedRunFacts = {
  state: 'succeeded',
  finishedAt: new Date('2026-11-18T12:00:00.000Z'),
  hasPullRequest: false,
  hasWorkingCopy: true,
  workingCopyRemoved: false,
};

describe('RetentionPolicy.countsAgainstLimit', () => {
  it('counts a finished Run with a Working copy and no pull request', () => {
    expect(policy.countsAgainstLimit(counted)).toBe(true);
  });

  it.each<[string, Partial<LimitedRunFacts>]>([
    ['is not final', { state: 'running' }],
    ['has no finish time', { finishedAt: null }],
    ['has a pull request', { hasPullRequest: true }],
    ['never had a Working copy', { hasWorkingCopy: false }],
    ['had its Working copy removed', { workingCopyRemoved: true }],
  ])('does not count a Run that %s', (_, patch) => {
    expect(policy.countsAgainstLimit({ ...counted, ...patch })).toBe(false);
  });
});
