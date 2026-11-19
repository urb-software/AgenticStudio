import { describe, expect, it } from 'vitest';
import { GitRequestRejectedError } from '../../../../application/ports/repository-git.js';
import { SystemGitAdapter } from '../system-git-adapter.js';

describe('the adapter branch check agrees with the domain rule', () => {
  const branches: [string, boolean][] = [
    ['dev', true],
    ['feature/x-1', true],
    ['release/1.0', true],
    ['a.b', true],
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
    ['a'.repeat(255), true],
    ['a'.repeat(256), false],
  ];

  it.each(branches)('branch %j accepted: %s', (branch, accepted) => {
    const adapter = Object.create(SystemGitAdapter.prototype) as {
      assertBranch(branch: string): void;
    };
    if (accepted) expect(() => adapter.assertBranch(branch)).not.toThrow();
    else expect(() => adapter.assertBranch(branch)).toThrow(GitRequestRejectedError);
  });
});
