import { describe, expect, it } from 'vitest';
import { RunCancellation } from '../run-cancellation.js';
import { IllegalRunTransitionError } from '../../errors/run-errors.js';
import { EarlierResult } from '../earlier-result.js';
import { RunLifecycle, type RunLifecycleData } from '../run-lifecycle.js';
import { RUN_STATES, FINAL_RUN_STATES, isFinalRunState, type RunState } from '../run-state.js';

const LEGAL: [RunState, RunState][] = [
  ['queued', 'preparing'],
  ['preparing', 'running'],
  ['preparing', 'failed'],
  ['running', 'waiting_for_operator'],
  ['running', 'succeeded'],
  ['running', 'failed'],
  ['waiting_for_operator', 'queued'],
  ['queued', 'cancelled'],
  ['preparing', 'cancelled'],
  ['running', 'cancelled'],
  ['waiting_for_operator', 'cancelled'],
  ['queued', 'timed_out'],
  ['preparing', 'timed_out'],
  ['running', 'timed_out'],
  ['waiting_for_operator', 'timed_out'],
];

const AT = new Date('2026-11-16T12:00:00.000Z');
const stored = (patch: Partial<RunLifecycleData> = {}): RunLifecycleData => ({
  ...RunLifecycle.start().toData(),
  ...patch,
});
const inState = (state: RunState): RunLifecycle =>
  RunLifecycle.restore(
    stored({
      state,
      failure: state === 'failed' ? failure('agent_failed') : null,
      cancellation: state === 'cancelled' ? { by: 'operator', reason: 'Cancelled.' } : null,
    }),
  );
const failure = (code: 'delivery_failed' | 'usage_limit' | 'agent_failed') => ({
  code,
  detail: 'It broke.',
});

describe('RunLifecycle transitions', () => {
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
    expect(inState(from).canTransitionTo(to)).toBe(true);
    expect(() => inState(from).assertTransitionTo(to)).not.toThrow();
  });

  it('rejects every other transition', () => {
    const legal = new Set(LEGAL.map(([from, to]) => `${from}->${to}`));
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        if (legal.has(`${from}->${to}`)) continue;
        expect(inState(from).canTransitionTo(to), `${from} -> ${to}`).toBe(false);
        expect(() => inState(from).assertTransitionTo(to)).toThrow(IllegalRunTransitionError);
      }
    }
  });

  it('treats succeeded, failed, cancelled and timed_out as final and terminal', () => {
    const final = RUN_STATES.filter(isFinalRunState);
    expect(final).toEqual(['succeeded', 'failed', 'cancelled', 'timed_out']);
    expect([...FINAL_RUN_STATES]).toEqual(final);
    for (const from of final) {
      expect(RUN_STATES.some((to) => inState(from).canTransitionTo(to))).toBe(false);
    }
  });

  it('names both states in the error', () => {
    expect(() => inState('succeeded').assertTransitionTo('running')).toThrow(
      'A Run cannot go from succeeded to running.',
    );
  });

  it('asks for the transition from its own state', () => {
    const lifecycle = RunLifecycle.restore(stored({ state: 'running' }));
    expect(() => lifecycle.assertTransitionTo('succeeded')).not.toThrow();
    expect(() => lifecycle.assertTransitionTo('queued')).toThrow(IllegalRunTransitionError);
  });
});

describe('RunLifecycle', () => {
  it('starts queued, with nothing started, finished, failed or cancelled', () => {
    expect(RunLifecycle.start().toData()).toEqual({
      state: 'queued',
      startedAt: null,
      finishedAt: null,
      failure: null,
      cancellation: null,
      cancelRequestedAt: null,
    });
  });

  it('is built only in a state the store may hold', () => {
    expect(() => RunLifecycle.restore(stored({ state: 'failed', failure: null }))).toThrow(
      TypeError,
    );
    expect(() =>
      RunLifecycle.restore(stored({ state: 'running', failure: failure('agent_failed') })),
    ).toThrow(TypeError);
    expect(() => RunLifecycle.restore(stored({ state: 'cancelled', cancellation: null }))).toThrow(
      TypeError,
    );
    expect(() =>
      RunLifecycle.restore(
        stored({ state: 'queued', cancellation: { ...RunCancellation.OPERATOR } }),
      ),
    ).toThrow(TypeError);
    expect(() => RunLifecycle.restore(stored({ state: 'paused' as RunState }))).toThrow(TypeError);
  });

  it('returns a new lifecycle for a change and leaves the old one as it was', () => {
    const queued = RunLifecycle.start();
    const preparing = queued.with({ state: 'preparing', startedAt: AT });

    expect(preparing).not.toBe(queued);
    expect(queued.state).toBe('queued');
    expect(queued.startedAt).toBeNull();
    expect(preparing.state).toBe('preparing');
    expect(preparing.startedAt).toEqual(AT);
  });

  it('ignores keys that belong to another concept', () => {
    const changed = RunLifecycle.start().with({ state: 'preparing', claimedBy: 'w' } as never);
    expect(changed.toData()).toEqual({ ...RunLifecycle.start().toData(), state: 'preparing' });
  });

  it('knows whether it is final and whether a stop was asked for', () => {
    expect(RunLifecycle.start().isFinal).toBe(false);
    expect(RunLifecycle.restore(stored({ state: 'timed_out' })).isFinal).toBe(true);
    expect(RunLifecycle.start().cancelRequested).toBe(false);
    expect(RunLifecycle.start().with({ cancelRequestedAt: AT }).cancelRequested).toBe(true);
  });

  it('can retry the delivery only when failed with delivery_failed', () => {
    const of = (state: RunState, code?: 'delivery_failed' | 'usage_limit') =>
      RunLifecycle.restore(
        stored({ state, ...(code === undefined ? {} : { failure: failure(code) }) }),
      );
    expect(of('failed', 'delivery_failed').canRetryDelivery).toBe(true);
    expect(of('failed', 'usage_limit').canRetryDelivery).toBe(false);
    expect(of('succeeded').canRetryDelivery).toBe(false);
  });

  it('keeps the Environment file for a retry or a resume only', () => {
    const failed = (code: 'delivery_failed' | 'usage_limit' | 'agent_failed') =>
      RunLifecycle.restore(stored({ state: 'failed', failure: failure(code) }));
    expect(failed('delivery_failed').keepsEnvironmentFileForRetry).toBe(true);
    expect(failed('usage_limit').keepsEnvironmentFileForRetry).toBe(true);
    expect(failed('usage_limit').stoppedAtUsageLimit).toBe(true);
    expect(failed('agent_failed').keepsEnvironmentFileForRetry).toBe(false);
    expect(RunLifecycle.restore(stored({ state: 'succeeded' })).keepsEnvironmentFileForRetry).toBe(
      false,
    );
  });
});

describe('RunLifecycle.partEnd and earlierResult', () => {
  it('records how a finished part ended: state, failure, delivery and the reason', () => {
    expect(
      RunLifecycle.restore(stored({ state: 'failed', failure: failure('agent_failed') })).partEnd(
        null,
      ),
    ).toEqual({
      state: 'failed',
      failureCode: 'agent_failed',
      delivery: null,
      detail: 'It broke.',
    });
    expect(
      RunLifecycle.restore(
        stored({ state: 'cancelled', cancellation: { ...RunCancellation.OPERATOR } }),
      ).partEnd(null),
    ).toEqual({
      state: 'cancelled',
      failureCode: null,
      delivery: null,
      detail: 'Cancelled by the operator.',
    });
    expect(RunLifecycle.restore(stored({ state: 'succeeded' })).partEnd('delivered')).toEqual({
      state: 'succeeded',
      failureCode: null,
      delivery: 'delivered',
      detail: '',
    });
    expect(RunLifecycle.restore(stored({ state: 'running' })).partEnd(null)).toBeNull();
  });

  it('gives back the result a part_end recorded, telling the cancel author from its reason', () => {
    expect(
      EarlierResult.of({
        state: 'failed',
        failureCode: 'agent_failed',
        delivery: null,
        detail: 'It broke.',
      }).toData(),
    ).toEqual({ state: 'failed', failure: failure('agent_failed'), cancellation: null });
    expect(
      EarlierResult.of({
        state: 'cancelled',
        failureCode: null,
        delivery: null,
        detail: 'Cancelled by the operator.',
      }).toData().cancellation,
    ).toEqual({ by: 'operator', reason: 'Cancelled by the operator.' });
    expect(
      EarlierResult.of({
        state: 'cancelled',
        failureCode: null,
        delivery: null,
        detail: 'Cancelled automatically: the run waited too long.',
      }).toData().cancellation?.by,
    ).toBe('system');
    expect(
      EarlierResult.of({
        state: 'succeeded',
        failureCode: null,
        delivery: 'none',
        detail: '',
      }).toData(),
    ).toEqual({ state: 'succeeded', failure: null, cancellation: null });
  });
});
