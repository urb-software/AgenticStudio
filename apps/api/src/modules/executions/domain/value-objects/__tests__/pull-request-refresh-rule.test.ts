import { describe, expect, it } from 'vitest';
import { PullRequestRefreshRule } from '../pull-request-refresh-rule.js';

describe('PullRequestRefreshRule', () => {
  const now = new Date('2026-11-18T12:00:00.000Z');

  it('refreshes pull requests older than a day', () => {
    expect(PullRequestRefreshRule.at(now).staleBefore).toEqual(
      new Date('2026-11-17T12:00:00.000Z'),
    );
  });

  it('keeps finished lookups for a week', () => {
    expect(PullRequestRefreshRule.at(now).finishedLookupsBefore).toEqual(
      new Date('2026-11-11T12:00:00.000Z'),
    );
  });
});
