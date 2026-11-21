import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import {
  GitCloneMissingError,
  GitOperationError,
  GitUnsupportedPlatformError,
} from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { InMemoryDeployKeys } from '../../../ports/__tests__/in-memory-deploy-keys.js';
import { FetchForReviewHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const RUN = '0b8e5c2d-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const BRANCH = 'agent/add-health-check-r0b8e5c2d';
const HEAD = 'a'.repeat(40);

describe('FetchForReviewHandler', () => {
  let connections: InMemoryRepositoryConnectionRepository;
  let git: FakeRepositoryGit;
  let handler: FetchForReviewHandler;

  const execute = (runBranch = BRANCH) =>
    handler.execute({ projectId: PROJECT, runId: RUN, runBranch });

  async function ready() {
    await connections.connect({
      projectId: PROJECT,
      url: 'https://github.com/acme/shop.git',
      identity: 'github.com/acme/shop',
      integrationBranch: 'dev',
    });
    await connections.change(PROJECT, (r) => {
      r.completeClone({ headSha: HEAD, fetchedAt: new Date() });
    });
  }

  beforeEach(() => {
    connections = new InMemoryRepositoryConnectionRepository();
    git = new FakeRepositoryGit();
    handler = new FetchForReviewHandler(connections, git, new InMemoryDeployKeys());
  });

  it('fetches the Integration branch and the Run branch and answers both commits', async () => {
    await ready();
    git.fetchForReview.mockResolvedValue({ runCommit: 'b'.repeat(40), integrationCommit: HEAD });

    expect(await execute()).toEqual({
      status: 'ready',
      runCommit: 'b'.repeat(40),
      integrationCommit: HEAD,
    });
    expect(git.fetchForReview).toHaveBeenCalledWith(
      PROJECT,
      'https://github.com/acme/shop.git',
      'dev',
      RUN,
      BRANCH,
      { ssh: undefined },
    );
  });

  it.each([
    ['another Run branch', 'agent/add-health-check-rdeadbeef'],
    ['the Integration branch', 'dev'],
    ['a branch outside agent/', 'feature/x-r0b8e5c2d'],
  ])('refuses %s before Git starts', async (_name, branch) => {
    await ready();

    const answer = await execute(branch);

    expect(answer.status).toBe('failed');
    expect(git.fetchForReview).not.toHaveBeenCalled();
  });

  it('is not ready without a Repository, or while it is not ready', async () => {
    expect(await execute()).toEqual({ status: 'repository_not_ready' });
    await connections.connect({
      projectId: PROJECT,
      url: 'https://github.com/acme/shop.git',
      identity: 'github.com/acme/shop',
      integrationBranch: 'dev',
    });
    expect(await execute()).toEqual({ status: 'repository_not_ready' });
    expect(git.fetchForReview).not.toHaveBeenCalled();
  });

  it('answers each Git failure instead of throwing', async () => {
    await ready();

    git.fetchForReview.mockRejectedValueOnce(new GitOperationError('branch_not_found'));
    expect(await execute()).toEqual({ status: 'branch_not_found' });

    git.fetchForReview.mockRejectedValueOnce(new GitUnsupportedPlatformError('win32'));
    expect(await execute()).toEqual({ status: 'unsupported_platform' });

    git.fetchForReview.mockRejectedValueOnce(new GitCloneMissingError());
    expect(await execute()).toEqual({ status: 'repository_not_ready' });

    git.fetchForReview.mockRejectedValueOnce(new GitOperationError('auth_failed', 'denied'));
    expect(await execute()).toEqual({ status: 'failed', detail: 'denied' });
  });

  it('lets an unexpected error through', async () => {
    await ready();
    git.fetchForReview.mockRejectedValueOnce(new Error('boom'));

    await expect(execute()).rejects.toThrow('boom');
  });
});
