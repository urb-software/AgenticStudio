import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  IllegalRunTransitionError,
  isFinal,
  longWaitCancellation,
  RUN_STATES,
  type Run,
  type RunState,
  stepLimitFailure,
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

// Issue #100: the long-wait rule and the step-limit failure.
describe('long-wait rule', () => {
  const since = new Date('2026-11-01T12:00:00.000Z');
  const waiting = (waitingDays: number, overrides: Partial<Run> = {}): Run => ({
    id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
    projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
    provider: 'codex',
    task: 'x',
    state: 'waiting_for_operator',
    startCommit: 'a',
    remoteUrl: 'https://git.example.test/a.git',
    workingCopy: null,
    createdAt: since,
    startedAt: since,
    finishedAt: null,
    failure: null,
    claimedBy: null,
    limits: { stepMinutes: 60, maxSteps: 10, waitingDays },
    cancelRequestedAt: null,
    cancellation: null,
    waitingSince: since,
    ...overrides,
  });
  const after = (days: number, extraMs = 0) =>
    new Date(since.getTime() + days * 24 * 60 * 60 * 1000 + extraMs);

  it('leaves a Run waiting exactly its limit alone', () => {
    expect(longWaitCancellation(waiting(14), after(14))).toBeNull();
  });

  it('cancels a Run waiting longer than its limit, by the system, saying why', () => {
    expect(longWaitCancellation(waiting(14), after(14, 1))).toEqual({
      by: 'system',
      reason: 'Cancelled automatically: the run waited for the operator longer than 14 days.',
    });
    expect(longWaitCancellation(waiting(1), after(2))?.reason).toBe(
      'Cancelled automatically: the run waited for the operator longer than 1 day.',
    );
  });

  it('applies only to a Run waiting for the operator', () => {
    expect(
      longWaitCancellation(waiting(1, { state: 'running', waitingSince: null }), after(30)),
    ).toBeNull();
  });
});

describe('step-limit failure', () => {
  it('says which limit was reached and that no further step was started', () => {
    expect(stepLimitFailure(10)).toEqual({
      code: 'step_limit',
      detail: 'The run reached its limit of 10 run steps; no further step was started.',
    });
  });
});
