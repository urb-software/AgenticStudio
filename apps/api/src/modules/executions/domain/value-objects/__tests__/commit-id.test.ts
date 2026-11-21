import { describe, expect, it } from 'vitest';
import { CommitId } from '../commit-id.js';

describe('CommitId', () => {
  it('equals the same commit in any letter case', () => {
    expect(CommitId.of('ABCdef0123').equals('abcDEF0123')).toBe(true);
  });

  it('does not equal another commit, or none', () => {
    expect(CommitId.of('a'.repeat(40)).equals('b'.repeat(40))).toBe(false);
    expect(CommitId.of('a'.repeat(40)).equals(null)).toBe(false);
  });
});
