import { describe, expect, it } from 'vitest';
import { RUN_STATES } from '../run-state.js';
import { LogAppendRule } from '../log-append-rule.js';

describe('LogAppendRule', () => {
  it('lets only the worker that holds a preparing or running Run append', () => {
    for (const state of RUN_STATES) {
      const held = state === 'preparing' || state === 'running';
      expect(LogAppendRule.for('w1').allows({ state, claimedBy: 'w1' })).toBe(held);
      expect(LogAppendRule.for('w2').allows({ state, claimedBy: 'w1' })).toBe(false);
      expect(LogAppendRule.for('w1').allows({ state, claimedBy: null })).toBe(false);
    }
  });
});
