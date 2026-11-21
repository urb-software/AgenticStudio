import { describe, expect, it } from 'vitest';
import type { MergeStudioFacts } from '../merge-studio-facts.js';
import { MergeStudioRule } from '../merge-studio-rule.js';

const COMMIT = 'b'.repeat(40);

function facts(overrides: Partial<MergeStudioFacts> = {}): MergeStudioFacts {
  return {
    commit: COMMIT,
    runActive: false,
    hasPullRequest: true,
    review: { state: 'ready', runCommit: COMMIT },
    ...overrides,
  };
}

describe('MergeStudioRule', () => {
  it('has no refusal for an ended Run with a pull request and a ready review of the commit', () => {
    expect(MergeStudioRule.of(facts()).refusal()).toBeNull();
  });

  it('refuses an active Run first', () => {
    const rule = MergeStudioRule.of(
      facts({ runActive: true, hasPullRequest: false, review: { state: 'none', runCommit: null } }),
    );
    expect(rule.refusal()).toBe('run_active');
  });

  it('refuses a Run without a pull request', () => {
    expect(MergeStudioRule.of(facts({ hasPullRequest: false })).refusal()).toBe(
      'pull_request_not_open',
    );
  });

  it.each(['none', 'preparing', 'failed', 'out_of_date'] as const)(
    'refuses a merge review that is %s as out of date',
    (state) => {
      expect(MergeStudioRule.of(facts({ review: { state, runCommit: COMMIT } })).refusal()).toBe(
        'review_out_of_date',
      );
    },
  );

  it('refuses a commit other than the one the review is of', () => {
    expect(MergeStudioRule.of(facts({ commit: 'c'.repeat(40) })).refusal()).toBe('commit_moved');
  });

  it('compares commits ignoring letter case', () => {
    expect(MergeStudioRule.of(facts({ commit: COMMIT.toUpperCase() })).refusal()).toBeNull();
  });
});
