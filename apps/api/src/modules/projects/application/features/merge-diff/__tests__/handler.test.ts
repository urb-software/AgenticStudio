import { beforeEach, describe, expect, it } from 'vitest';
import {
  GitCloneMissingError,
  GitOperationError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
} from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { MergeDiffHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const RUN = '0b8e5c2d-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const LIMITS = { filesMax: 10, filePatchMaxBytes: 1000, patchMaxBytes: 5000 };

describe('MergeDiffHandler', () => {
  let git: FakeRepositoryGit;
  let handler: MergeDiffHandler;

  const execute = (projectId = PROJECT) =>
    handler.execute({
      projectId,
      runId: RUN,
      runCommit: 'b'.repeat(40),
      integrationCommit: 'a'.repeat(40),
      limits: LIMITS,
    });

  beforeEach(() => {
    git = new FakeRepositoryGit();
    handler = new MergeDiffHandler(git);
  });

  it('passes the commits and the limits to Git and answers its outcome', async () => {
    git.mergeDiff.mockResolvedValue({
      status: 'computed',
      files: [{ path: 'a.txt', status: 'added', patch: '+x', cut: false }],
      truncated: false,
    });

    expect(await execute()).toEqual({
      status: 'computed',
      files: [{ path: 'a.txt', status: 'added', patch: '+x', cut: false }],
      truncated: false,
    });
    expect(git.mergeDiff).toHaveBeenCalledWith(
      PROJECT,
      RUN,
      'b'.repeat(40),
      'a'.repeat(40),
      LIMITS,
    );
  });

  it('answers a conflict', async () => {
    git.mergeDiff.mockResolvedValue({ status: 'conflicting' });

    expect(await execute()).toEqual({ status: 'conflicting' });
  });

  it('names a project id that is not a UUID as not ready, without calling Git', async () => {
    expect(await execute('not-a-uuid')).toEqual({ status: 'repository_not_ready' });
    expect(git.mergeDiff).not.toHaveBeenCalled();
  });

  it('answers each Git failure instead of throwing', async () => {
    git.mergeDiff.mockRejectedValueOnce(new GitUnsupportedPlatformError('win32'));
    expect(await execute()).toEqual({ status: 'unsupported_platform' });

    git.mergeDiff.mockRejectedValueOnce(new GitCloneMissingError());
    expect(await execute()).toEqual({ status: 'repository_not_ready' });

    git.mergeDiff.mockRejectedValueOnce(new GitOperationError('unknown', 'bad object'));
    expect(await execute()).toEqual({ status: 'failed', detail: 'bad object' });

    git.mergeDiff.mockRejectedValueOnce(new GitRequestRejectedError('malformed'));
    expect(await execute()).toEqual({ status: 'failed', detail: 'malformed' });
  });
});
