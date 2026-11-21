import { describe, expect, it } from 'vitest';
import type { MergeHostFacts } from '../merge-host-facts.js';
import { MergeHostRule } from '../merge-host-rule.js';

const COMMIT = 'b'.repeat(40);

function refusal(
  pullRequest: Partial<MergeHostFacts['pullRequest']> = {},
  checks: MergeHostFacts['checks'] = [],
) {
  return MergeHostRule.of({
    commit: COMMIT,
    pullRequest: {
      state: 'open',
      headSha: COMMIT,
      mergeable: true,
      mergeableState: 'clean',
      ...pullRequest,
    },
    checks,
  }).refusal();
}

describe('MergeHostRule', () => {
  it('has no refusal for an open pull request at the commit with passing checks', () => {
    expect(
      refusal({}, [
        { name: 'ci', state: 'success' },
        { name: 'docs', state: 'neutral' },
      ]),
    ).toBeNull();
  });

  it('has no refusal when the commit has no checks at all', () => {
    expect(refusal()).toBeNull();
  });

  it.each(['merged', 'closed'] as const)('refuses a %s pull request', (state) => {
    expect(refusal({ state })).toBe('pull_request_not_open');
  });

  it('refuses a head that is not the approved commit, ignoring letter case', () => {
    expect(refusal({ headSha: 'c'.repeat(40) })).toBe('commit_moved');
    expect(refusal({ headSha: COMMIT.toUpperCase() })).toBeNull();
  });

  it('refuses a failing check, and a running one', () => {
    expect(refusal({}, [{ name: 'ci', state: 'failure' }])).toBe('checks_failing');
    expect(refusal({}, [{ name: 'ci', state: 'pending' }])).toBe('checks_running');
  });

  it('names a failing check before a running one', () => {
    expect(
      refusal({}, [
        { name: 'a', state: 'pending' },
        { name: 'b', state: 'failure' },
      ]),
    ).toBe('checks_failing');
  });

  it('refuses a conflict, from mergeable or from a dirty merge state', () => {
    expect(refusal({ mergeable: false })).toBe('conflicting');
    expect(refusal({ mergeableState: 'dirty' })).toBe('conflicting');
  });

  it('answers checks_running while the host has not computed mergeability, instead of guessing', () => {
    expect(refusal({ mergeable: null, mergeableState: 'unknown' })).toBe('checks_running');
  });

  it('refuses a pull request that is not open before anything else', () => {
    expect(
      refusal({ state: 'merged', headSha: 'c'.repeat(40), mergeable: false }, [
        { name: 'ci', state: 'failure' },
      ]),
    ).toBe('pull_request_not_open');
  });
});
