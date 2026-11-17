import { describe, expect, it } from 'vitest';
import { RUN_STATES } from '../run-state.js';
import { LogAppendRule } from '../log-append-rule.js';

describe('LogAppendRule', () => {
  it('lets only the worker that holds a preparing or running Run append', () => {
    for (const state of RUN_STATES) {
      const held = state === 'preparing' || state === 'running';
      expect(LogAppendRule.allows({ state, claimedBy: 'w1' }, 'w1')).toBe(held);
      expect(LogAppendRule.allows({ state, claimedBy: 'w1' }, 'w2')).toBe(false);
      expect(LogAppendRule.allows({ state, claimedBy: null }, 'w1')).toBe(false);
    }
  });
});
