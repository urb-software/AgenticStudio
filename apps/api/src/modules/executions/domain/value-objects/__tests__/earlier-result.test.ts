import { describe, expect, it } from 'vitest';
import { EarlierResult } from '../earlier-result.js';

describe('EarlierResult', () => {
  it('gives back a failure with its code and detail', () => {
    expect(
      EarlierResult.of({
        state: 'failed',
        failureCode: 'agent_failed',
        delivery: null,
        detail: 'It broke.',
      }).toData(),
    ).toEqual({
      state: 'failed',
      failure: { code: 'agent_failed', detail: 'It broke.' },
      cancellation: null,
    });
  });

  it('tells the author of a cancel from its reason', () => {
    const cancelled = (detail: string) =>
      EarlierResult.of({ state: 'cancelled', failureCode: null, delivery: null, detail }).toData()
        .cancellation;
    expect(cancelled('Cancelled by the operator.')?.by).toBe('operator');
    expect(cancelled('Cancelled automatically: the run waited too long.')?.by).toBe('system');
  });

  it('gives back a success with neither failure nor cancellation', () => {
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
