import { describe, expect, it } from 'vitest';
import { RunDiffState } from '../run-diff-state.js';

const ids = {
  resultTree: 'a'.repeat(40),
  resultCommit: 'b'.repeat(64),
  previousTree: 'c'.repeat(40),
  previousCommit: 'd'.repeat(40),
};

describe('RunDiffState', () => {
  it('takes object ids only and refuses anything else', () => {
    expect(RunDiffState.of(ids).snapshot()).toEqual(ids);
    expect(() => RunDiffState.of({ ...ids, resultTree: 'HEAD' })).toThrow(
      'The diff state is not object ids.',
    );
    expect(() => RunDiffState.of({ ...ids, pushedCommit: 'E'.repeat(40) })).toThrow();
  });

  it('restores a stored state without checking it again', () => {
    expect(RunDiffState.restore({ ...ids, resultTree: 'legacy' }).resultTree).toBe('legacy');
  });
});
