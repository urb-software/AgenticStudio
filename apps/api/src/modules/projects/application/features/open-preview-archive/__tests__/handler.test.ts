import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import {
  type CommitArchive,
  GitCloneMissingError,
  GitOperationError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
} from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { OpenPreviewArchiveHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const COMMIT = 'c'.repeat(40);
const MAX = 1024;

describe('OpenPreviewArchiveHandler', () => {
  let projects: InMemoryProjectRepository;
  let connections: InMemoryRepositoryConnectionRepository;
  let git: FakeRepositoryGit;
  let handler: OpenPreviewArchiveHandler;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
    git = new FakeRepositoryGit();
    handler = new OpenPreviewArchiveHandler(projects, connections, git);
  });

  async function readyRepository() {
    projects.addProject(PROJECT, 'Shop');
    await connections.connect({
      projectId: PROJECT,
      url: 'https://github.com/acme/shop.git',
      identity: 'github.com/acme/shop',
      integrationBranch: 'dev',
    });
    await connections.change(PROJECT, (r) => {
      r.completeClone({ headSha: COMMIT, fetchedAt: new Date() });
    });
  }

  const open = (commit = COMMIT) => handler.execute({ projectId: PROJECT, commit, maxBytes: MAX });

  function archive(): CommitArchive {
    return {
      sizeBytes: 3,
      chunks: async function* () {
        yield new Uint8Array([1, 2, 3]);
      },
      close: vi.fn(() => Promise.resolve()),
    };
  }

  it('hands out the archive of the commit with its size and a close', async () => {
    await readyRepository();
    const held = archive();
    git.archiveCommit.mockResolvedValueOnce({ status: 'archived', archive: held });

    const result = await open();

    expect(git.archiveCommit).toHaveBeenCalledWith(PROJECT, COMMIT, MAX);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.sizeBytes).toBe(3);
    const bytes: number[] = [];
    for await (const chunk of result.chunks) bytes.push(...chunk);
    expect(bytes).toEqual([1, 2, 3]);
    await result.close();
    expect(held.close).toHaveBeenCalledTimes(1);
  });

  it.each(['commit_missing', 'too_large'] as const)('passes %s through', async (status) => {
    await readyRepository();
    git.archiveCommit.mockResolvedValueOnce({ status });
    await expect(open()).resolves.toEqual({ status });
  });

  it('does not open an archive for an unknown project or a Repository that is not ready', async () => {
    await expect(open()).resolves.toEqual({ status: 'repository_not_ready' });
    await expect(
      handler.execute({ projectId: 'nope', commit: COMMIT, maxBytes: MAX }),
    ).resolves.toEqual({ status: 'repository_not_ready' });
    projects.addProject(PROJECT, 'Shop');
    await expect(open()).resolves.toEqual({ status: 'repository_not_ready' });
    expect(git.archiveCommit).not.toHaveBeenCalled();
  });

  it('is unsupported off Linux', async () => {
    await readyRepository();
    git.archiveCommit.mockRejectedValueOnce(new GitUnsupportedPlatformError('win32'));
    await expect(open()).resolves.toEqual({ status: 'unsupported_platform' });
  });

  it('is not ready when the Clone is gone', async () => {
    await readyRepository();
    git.archiveCommit.mockRejectedValueOnce(new GitCloneMissingError());
    await expect(open()).resolves.toEqual({ status: 'repository_not_ready' });
  });

  it.each([new GitOperationError('unknown'), new GitRequestRejectedError('bad commit')])(
    'fails on a refusal or an operation failure of Git',
    async (error) => {
      await readyRepository();
      git.archiveCommit.mockRejectedValueOnce(error);
      await expect(open()).resolves.toEqual({ status: 'failed' });
    },
  );

  it('rethrows a bug', async () => {
    await readyRepository();
    git.archiveCommit.mockRejectedValueOnce(new TypeError('bug'));
    await expect(open()).rejects.toThrow(TypeError);
  });
});
