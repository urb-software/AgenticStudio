import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import {
  GitCloneMissingError,
  GitCommitMissingError,
  GitOperationError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
} from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { ReadDefinitionsBlobsHandler } from '../handler.js';

const DEFINITIONS = '4a3c9d2f-5e6b-4c7d-8e8f-9a0b1c2d3e4f';
const HEAD = 'c'.repeat(40);
const PATHS = ['agents/a/logo.png', 'agents/a/run.sh'];

describe('ReadDefinitionsBlobsHandler', () => {
  let projects: InMemoryProjectRepository;
  let connections: InMemoryRepositoryConnectionRepository;
  let git: FakeRepositoryGit;
  let handler: ReadDefinitionsBlobsHandler;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
    git = new FakeRepositoryGit();
    handler = new ReadDefinitionsBlobsHandler(projects, connections, git);
  });

  async function connected() {
    projects.addProject(DEFINITIONS, 'Agents', 'definitions');
    await connections.connect({
      projectId: DEFINITIONS,
      url: 'https://github.com/acme/agents.git',
      identity: 'github.com/acme/agents',
      integrationBranch: 'main',
    });
  }

  it('reads the bytes of the files of the definitions Clone at the commit, in order', async () => {
    await connected();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    git.readBlobsAtCommit.mockResolvedValueOnce([
      { path: PATHS[0]!, outcome: { status: 'found', bytes: png } },
      { path: PATHS[1]!, outcome: { status: 'too_large' } },
    ]);

    await expect(handler.execute({ commit: HEAD, paths: PATHS, maxBytes: 100 })).resolves.toEqual({
      status: 'read',
      files: [
        { path: PATHS[0], status: 'found', bytes: png },
        { path: PATHS[1], status: 'too_large' },
      ],
    });
    expect(git.readBlobsAtCommit).toHaveBeenCalledWith(DEFINITIONS, HEAD, PATHS, 100);
  });

  it('is not ready without a definitions Project or a Repository', async () => {
    await expect(handler.execute({ commit: HEAD, paths: PATHS, maxBytes: 1 })).resolves.toEqual({
      status: 'repository_not_ready',
    });
    projects.addProject(DEFINITIONS, 'Agents', 'definitions');
    await expect(handler.execute({ commit: HEAD, paths: PATHS, maxBytes: 1 })).resolves.toEqual({
      status: 'repository_not_ready',
    });
    expect(git.readBlobsAtCommit).not.toHaveBeenCalled();
  });

  it.each([
    [new GitUnsupportedPlatformError('win32'), 'unsupported_platform'],
    [new GitCloneMissingError(), 'repository_not_ready'],
    [new GitCommitMissingError(), 'commit_missing'],
    [new GitRequestRejectedError('bad commit'), 'failed'],
    [new GitOperationError('unknown'), 'failed'],
  ] as const)('maps %s to %s', async (error, status) => {
    await connected();
    git.readBlobsAtCommit.mockRejectedValueOnce(error);

    await expect(handler.execute({ commit: HEAD, paths: PATHS, maxBytes: 1 })).resolves.toEqual({
      status,
    });
  });

  it('does not hide an unexpected error', async () => {
    await connected();
    git.readBlobsAtCommit.mockRejectedValueOnce(new Error('boom'));

    await expect(handler.execute({ commit: HEAD, paths: PATHS, maxBytes: 1 })).rejects.toThrow(
      'boom',
    );
  });
});
