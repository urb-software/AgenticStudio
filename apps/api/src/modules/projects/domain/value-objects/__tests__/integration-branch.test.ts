import { describe, expect, it } from 'vitest';
import {
  IntegrationBranch,
  INTEGRATION_BRANCH_PATTERN,
  InvalidIntegrationBranchError,
} from '../integration-branch.js';

describe('IntegrationBranch.parse', () => {
  it.each(['dev', 'main', 'release/2026.11', 'feature/x-y_z', 'v1.0', 'a', 'ü-branch', 'x@y'])(
    'accepts %j',
    (name) => {
      expect(IntegrationBranch.parse(name).value).toBe(name);
    },
  );

  it('trims surrounding whitespace', () => {
    expect(IntegrationBranch.parse('  dev ').value).toBe('dev');
  });

  // The cases of `git check-ref-format --branch`, which the Git adapter enforces too.
  it.each([
    '',
    '   ',
    '@',
    '-dev',
    '/dev',
    'dev/',
    '.dev',
    'dev.',
    'a..b',
    'a//b',
    'a@{1}',
    'a/.b',
    'dev.lock',
    'a.lock/b',
    'has space',
    'tab\tbranch',
    'ctrl\u0001',
    'del\u007f',
    'til~de',
    'ca^ret',
    'co:lon',
    'que?ry',
    'st*ar',
    'br[acket',
    'back\\slash',
    'x'.repeat(256),
  ])('rejects %j', (name) => {
    expect(() => IntegrationBranch.parse(name)).toThrow(InvalidIntegrationBranchError);
  });

  it('publishes a pattern without the u flag, as JSON Schema needs', () => {
    expect(INTEGRATION_BRANCH_PATTERN.flags).toBe('');
  });
});
