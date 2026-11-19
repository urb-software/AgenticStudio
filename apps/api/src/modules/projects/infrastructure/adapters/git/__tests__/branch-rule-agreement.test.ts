import { describe, expect, it } from 'vitest';
import { GitRequestRejectedError } from '../../../../application/ports/repository-git.js';
import { SystemGitAdapter } from '../system-git-adapter.js';

type BranchCheck = { assertBranch(branch: string): void };

// The expected column is written by hand from `git check-ref-format --branch`, not from the code.
const CASES: [string, boolean][] = [
  ['dev', true],
  ['feature/x-1', true],
  ['release/1.0', true],
  ['a.b', true],
  ['x@y', true],
  ['a'.repeat(255), true],
  ['', false],
  ['@', false],
  ['-x', false],
  ['/x', false],
  ['x/', false],
  ['x.', false],
  ['a..b', false],
  ['a//b', false],
  ['a@{b', false],
  ['a b', false],
  [' dev', false],
  ['dev ', false],
  ['a~b', false],
  ['a^b', false],
  ['a:b', false],
  ['a?b', false],
  ['a*b', false],
  ['a[b', false],
  ['a\b', false],
  ['a\u007fb', false],
  ['a\u0001b', false],
  ['.hidden', false],
  ['a/.hidden', false],
  ['x.lock', false],
  ['x.lock/y', false],
  ['a ..b', false],
  ['a //b', false],
  ['a @{u}', false],
  ['a x.lock', false],
  ['a'.repeat(256), false],
];

describe('the adapter branch check', () => {
  const adapter = Object.create(SystemGitAdapter.prototype) as BranchCheck;

  it.each(CASES)('for %j accepts: %s', (branch, accepted) => {
    const check = () => adapter.assertBranch(branch);
    if (accepted) expect(check).not.toThrow();
    else expect(check).toThrow(GitRequestRejectedError);
  });
});
