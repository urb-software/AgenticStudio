import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  IllegalRunTransitionError,
  isFinal,
  RUN_STATES,
  type RunState,
} from '../run.js';

// Issue #96: the Run state machine, enforced in the domain.
const LEGAL: [RunState, RunState][] = [
  ['queued', 'preparing'],
  ['preparing', 'running'],
  ['preparing', 'failed'],
  ['running', 'waiting_for_operator'],
  ['running', 'succeeded'],
  ['running', 'failed'],
  ['waiting_for_operator', 'running'],
  ['queued', 'cancelled'],
  ['preparing', 'cancelled'],
  ['running', 'cancelled'],
  ['waiting_for_operator', 'cancelled'],
  ['queued', 'timed_out'],
  ['preparing', 'timed_out'],
  ['running', 'timed_out'],
  ['waiting_for_operator', 'timed_out'],
];

describe('Run transitions', () => {
  it('lists the eight states', () => {
    expect(RUN_STATES).toEqual([
      'queued',
      'preparing',
      'running',
      'waiting_for_operator',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
    ]);
  });

  it.each(LEGAL)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('rejects every other transition', () => {
    const legal = new Set(LEGAL.map(([from, to]) => `${from}->${to}`));
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        if (legal.has(`${from}->${to}`)) continue;
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
        expect(() => assertTransition(from, to)).toThrow(IllegalRunTransitionError);
      }
    }
  });

  it('treats succeeded, failed, cancelled and timed_out as final and terminal', () => {
    const final = RUN_STATES.filter(isFinal);
    expect(final).toEqual(['succeeded', 'failed', 'cancelled', 'timed_out']);
    for (const from of final) {
      expect(RUN_STATES.some((to) => canTransition(from, to))).toBe(false);
    }
  });

  it('names both states in the error', () => {
    expect(() => assertTransition('succeeded', 'running')).toThrow(
      'A Run cannot go from succeeded to running.',
    );
  });
});
