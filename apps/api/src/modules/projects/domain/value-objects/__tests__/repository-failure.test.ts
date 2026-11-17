import { describe, expect, it } from 'vitest';
import {
  FAILURE_DETAIL_MAX_LENGTH,
  GIT_FAILURE_WITHOUT_OUTPUT_DETAIL,
  HOST_KEY_CHANGED_DETAIL,
  NO_TRUSTED_HOST_KEY_DETAIL,
  NOT_STARTED_DETAIL,
  REMOTE_DEFAULT_BRANCH_MAX_LENGTH,
  RepositoryFailure,
  UNEXPECTED_FAILURE_DETAIL,
} from '../repository-failure.js';

describe('RepositoryFailure', () => {
  it('cuts an over-long detail and leaves out an over-long default branch', () => {
    const failure = RepositoryFailure.of(
      'branch_not_found',
      'x'.repeat(FAILURE_DETAIL_MAX_LENGTH + 5),
      'b'.repeat(REMOTE_DEFAULT_BRANCH_MAX_LENGTH + 1),
    );

    expect(failure.detail).toHaveLength(FAILURE_DETAIL_MAX_LENGTH);
    expect(failure.detail.endsWith('…')).toBe(true);
    expect(failure.remoteDefaultBranch).toBeNull();
    expect(RepositoryFailure.of('branch_not_found', '', 'main').remoteDefaultBranch).toBe('main');
  });

  it('explains a changed host key first, then the Git output', () => {
    expect(RepositoryFailure.fromGit('host_key_mismatch', 'REMOTE HOST')).toMatchObject({
      code: 'host_key_mismatch',
      detail: `${HOST_KEY_CHANGED_DETAIL}\n\nREMOTE HOST`,
    });
    expect(RepositoryFailure.fromGit('host_key_mismatch').detail).toBe(HOST_KEY_CHANGED_DETAIL);
  });

  it('keeps the Git output of other reasons, and says so when an unknown one has none', () => {
    expect(RepositoryFailure.fromGit('auth_failed', 'denied').detail).toBe('denied');
    expect(RepositoryFailure.fromGit('unknown').detail).toBe(GIT_FAILURE_WITHOUT_OUTPUT_DETAIL);
  });

  it('has fixed failures for no trusted host key, a crash, an unexpected error and a clone not started', () => {
    expect(RepositoryFailure.noTrustedHostKey()).toMatchObject({
      code: 'host_key_mismatch',
      detail: NO_TRUSTED_HOST_KEY_DETAIL,
    });
    expect(RepositoryFailure.interrupted()).toMatchObject({ code: 'interrupted', detail: '' });
    expect(RepositoryFailure.unexpected()).toMatchObject({
      code: 'unknown',
      detail: UNEXPECTED_FAILURE_DETAIL,
    });
    expect(RepositoryFailure.notStarted()).toMatchObject({
      code: 'unknown',
      detail: NOT_STARTED_DETAIL,
    });
  });

  it.each([
    [{ reason: 'timeout' }, 'timeout', 'The clone took too long and was stopped.'],
    [{ reason: 'cancelled' }, 'unknown', 'Cancelled'],
    [{ reason: 'stalled' }, 'interrupted', ''],
    [{ reason: 'shutdown' }, 'interrupted', ''],
    [{ reason: 'error', error: new Error('x') }, 'unknown', UNEXPECTED_FAILURE_DETAIL],
  ] as const)('maps an unfinished job %j', (job, code, detail) => {
    expect(RepositoryFailure.fromUnfinishedJob('clone', job)).toMatchObject({ code, detail });
  });
});
