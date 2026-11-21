import { describe, expect, it } from 'vitest';
import { isMergeMethod, MERGE_METHODS } from '../merge-method.js';

describe('MergeMethod', () => {
  it('is squash or merge commit; rebase is not a value', () => {
    expect([...MERGE_METHODS]).toEqual(['squash', 'merge_commit']);
  });

  it.each(['squash', 'merge_commit'])('accepts %s', (value) => {
    expect(isMergeMethod(value)).toBe(true);
  });

  it.each(['rebase', 'merge', 'Squash', '', null, undefined, 1])('refuses %j', (value) => {
    expect(isMergeMethod(value)).toBe(false);
  });
});
