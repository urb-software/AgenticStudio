import { describe, expect, it } from 'vitest';
import { RunStep } from '../run-step.js';

describe('RunStep', () => {
  it('is created for a number from 1, not yet stored', () => {
    const step = RunStep.create({ index: 1, kind: 'start', result: { outcome: 'done' } });

    expect(step).toEqual(RunStep.restore({ index: 1, kind: 'start', result: { outcome: 'done' } }));
    expect(step).toMatchObject({ index: 1, kind: 'start', result: { outcome: 'done' } });
    expect(step.reportedAt).toBeUndefined();
  });

  it('refuses a number that is not a positive integer', () => {
    for (const index of [0, -1, 1.5]) {
      expect(() => RunStep.create({ index, kind: 'start', result: null })).toThrow(TypeError);
    }
  });

  it('is restored with the time the store recorded it', () => {
    const reportedAt = new Date('2026-11-17T12:00:00.000Z');

    expect(RunStep.restore({ index: 2, kind: 'resume', result: {}, reportedAt })).toMatchObject({
      index: 2,
      kind: 'resume',
      result: {},
      reportedAt,
    });
  });
});
