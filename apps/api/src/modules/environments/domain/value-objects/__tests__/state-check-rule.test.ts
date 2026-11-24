import { describe, expect, it } from 'vitest';
import { StateCheckRule } from '../state-check-rule.js';

const rule = StateCheckRule.create();
const CLAIMED = new Date('2026-11-24T10:00:00.000Z');
const newest = (over: Partial<Parameters<StateCheckRule['selects']>[0]> = {}) => ({
  kind: 'build',
  status: 'failed',
  claimedAt: CLAIMED,
  failureCode: 'controller_lost',
  ...over,
});

describe('StateCheckRule', () => {
  it.each(['controller_lost', 'report_overdue'])('selects a claimed build failed as %s', (code) => {
    expect(rule.selects(newest({ failureCode: code }))).toBe(true);
  });

  it('selects no other failure, status or kind', () => {
    expect(rule.selects(newest({ failureCode: 'build_failed' }))).toBe(false);
    expect(rule.selects(newest({ failureCode: 'not_claimed' }))).toBe(false);
    expect(rule.selects(newest({ failureCode: null }))).toBe(false);
    expect(rule.selects(newest({ status: 'claimed' }))).toBe(false);
    expect(rule.selects(newest({ kind: 'state' }))).toBe(false);
    expect(rule.selects(newest({ kind: 'stop' }))).toBe(false);
  });

  it('selects no build that no controller ever claimed', () => {
    expect(rule.selects(newest({ claimedAt: null }))).toBe(false);
  });
});
