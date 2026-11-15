import { describe, expect, it } from 'vitest';
import { excludePattern } from '../working-copy.js';

// Issue #104: the `.git/info/exclude` line for a Studio-placed file matches exactly its path.

describe('excludePattern', () => {
  it.each([
    ['.env', '/.env'],
    ['config/test.env', '/config/test.env'],
    ['conf/[a]*.env', '/conf/\\[a]\\*.env'],
    ['what?.env', '/what\\?.env'],
    ['a\\b', '/a\\\\b'],
    ['trailing  ', '/trailing\\ \\ '],
  ])('writes %j as %j', (path, pattern) => {
    expect(excludePattern(path)).toBe(pattern);
  });
});
