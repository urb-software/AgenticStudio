import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import {
  GitCloneMissingError,
  GitCommitMissingError,
  GitOperationError,
  GitUnsupportedPlatformError,
} from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { ReadDefinitionsBlobIdsHandler } from '../handler.js';

const DEFINITIONS = '4a3c9d2f-5e6b-4c7d-8e8f-9a0b1c2d3e4f';
const HEAD = 'c'.repeat(40);
const PATHS = ['agents/a/AGENT.md', 'agents/gone.md'];

describe('ReadDefinitionsBlobIdsHandler', () => {
  let projects: InMemoryProjectRepository;
  let connections: InMemoryRepositoryConnectionRepository;
  let git: FakeRepositoryGit;
  let handler: ReadDefinitionsBlobIdsHandler;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
    git = new FakeRepositoryGit();
    handler = new ReadDefinitionsBlobIdsHandler(projects, connections, git);
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

  it('answers the blob id of each path of the definitions Clone at the commit, null for none', async () => {
    await connected();
    git.blobIdsAtCommit.mockResolvedValueOnce([
      { path: PATHS[0]!, blob: 'd'.repeat(40), executable: true },
      { path: PATHS[1]!, blob: null, executable: false },
    ]);

    await expect(handler.execute({ commit: HEAD, paths: PATHS })).resolves.toEqual({
      status: 'read',
      blobs: [
        { path: PATHS[0], blob: 'd'.repeat(40), executable: true },
        { path: PATHS[1], blob: null, executable: false },
      ],
    });
    expect(git.blobIdsAtCommit).toHaveBeenCalledWith(DEFINITIONS, HEAD, PATHS);
  });

  it('is not ready without a definitions Project or a Repository', async () => {
    await expect(handler.execute({ commit: HEAD, paths: PATHS })).resolves.toEqual({
      status: 'repository_not_ready',
    });
    projects.addProject(DEFINITIONS, 'Agents', 'definitions');
    await expect(handler.execute({ commit: HEAD, paths: PATHS })).resolves.toEqual({
      status: 'repository_not_ready',
    });
    expect(git.blobIdsAtCommit).not.toHaveBeenCalled();
  });

  it.each([
    [new GitUnsupportedPlatformError('win32'), 'unsupported_platform'],
    [new GitCloneMissingError(), 'repository_not_ready'],
    [new GitCommitMissingError(), 'commit_missing'],
    [new GitOperationError('unknown'), 'failed'],
  ] as const)('maps %s to %s', async (error, status) => {
    await connected();
    git.blobIdsAtCommit.mockRejectedValueOnce(error);

    await expect(handler.execute({ commit: HEAD, paths: PATHS })).resolves.toEqual({ status });
  });

  it('lets an unexpected error through', async () => {
    await connected();
    git.blobIdsAtCommit.mockRejectedValueOnce(new TypeError('bug'));

    await expect(handler.execute({ commit: HEAD, paths: PATHS })).rejects.toThrow(TypeError);
  });
});
