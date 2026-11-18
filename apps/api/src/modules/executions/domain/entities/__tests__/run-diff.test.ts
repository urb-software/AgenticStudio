import { describe, expect, it } from 'vitest';
import type { NewRunDiff } from '../../value-objects/run-diff.js';
import { RunDiff } from '../run-diff.js';

const ID = 'a'.repeat(40);
const diffs: Record<'run' | 'last', NewRunDiff> = {
  run: { kind: 'unavailable', reason: 'No Working copy.' },
  last: { kind: 'unavailable', reason: 'No Working copy.' },
};
const state = { resultTree: ID, resultCommit: ID, previousTree: ID, previousCommit: ID };

describe('RunDiff', () => {
  it('is reported for a Run with its diffs and state, and gives them back as a snapshot', () => {
    const report = RunDiff.report({ runId: 'r-1', diffs, state });

    expect(report.snapshot()).toEqual({ runId: 'r-1', diffs, state });
  });

  it('keeps the stored state when the report has none (the diffs were unavailable)', () => {
    expect(RunDiff.report({ runId: 'r-1', diffs, state: null }).state).toBeNull();
  });

  it('refuses a state that is not object ids', () => {
    expect(() =>
      RunDiff.report({ runId: 'r-1', diffs, state: { ...state, resultTree: 'not-an-id' } }),
    ).toThrow('The diff state is not object ids.');
  });
});
