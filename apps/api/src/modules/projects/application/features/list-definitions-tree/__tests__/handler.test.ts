import { AGENTS_DIRECTORY } from '@agentic-studio/agent-definitions';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFINITIONS_TREE_MAX_ENTRIES } from '../../../../contracts/index.js';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import {
  GitCloneMissingError,
  GitOperationError,
  GitUnsupportedPlatformError,
} from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { ListDefinitionsTreeHandler } from '../handler.js';

const CODE = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const DEFINITIONS = '4a3c9d2f-5e6b-4c7d-8e8f-9a0b1c2d3e4f';
const HEAD = 'c'.repeat(40);

describe('ListDefinitionsTreeHandler', () => {
  let projects: InMemoryProjectRepository;
  let connections: InMemoryRepositoryConnectionRepository;
  let git: FakeRepositoryGit;
  let handler: ListDefinitionsTreeHandler;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
    git = new FakeRepositoryGit();
    handler = new ListDefinitionsTreeHandler(projects, connections, git);
  });

  async function connected() {
    projects.addProject(DEFINITIONS, 'Agents', 'definitions');
    await connections.connect({
      projectId: DEFINITIONS,
      url: 'https://github.com/acme/agents.git',
      identity: 'github.com/acme/agents',
      integrationBranch: 'main',
    });
    await connections.change(DEFINITIONS, (r) => {
      r.completeClone({ headSha: HEAD, fetchedAt: new Date() });
    });
  }

  it('lists the agents folder of the definitions Clone at the commit, within the bound', async () => {
    await connected();
    const entries = [{ path: 'agents/a/AGENT.md', kind: 'file', size: 10 }] as const;
    git.listTreeAtCommit.mockResolvedValueOnce({ entries: [...entries], truncated: true });

    await expect(handler.execute({ commit: HEAD })).resolves.toEqual({
      status: 'listed',
      entries: [...entries],
      truncated: true,
    });
    expect(git.listTreeAtCommit).toHaveBeenCalledWith(
      DEFINITIONS,
      HEAD,
      AGENTS_DIRECTORY,
      DEFINITIONS_TREE_MAX_ENTRIES,
    );
  });

  it('is not ready without a definitions Project or without a Repository', async () => {
    projects.addProject(CODE, 'Shop');
    await expect(handler.execute({ commit: HEAD })).resolves.toEqual({
      status: 'repository_not_ready',
    });
    projects.addProject(DEFINITIONS, 'Agents', 'definitions');
    await expect(handler.execute({ commit: HEAD })).resolves.toEqual({
      status: 'repository_not_ready',
    });
    expect(git.listTreeAtCommit).not.toHaveBeenCalled();
  });

  it.each([
    [new GitUnsupportedPlatformError('win32'), 'unsupported_platform'],
    [new GitCloneMissingError(), 'repository_not_ready'],
    [new GitOperationError('unknown'), 'failed'],
  ] as const)('maps %s to %s', async (error, status) => {
    await connected();
    git.listTreeAtCommit.mockRejectedValueOnce(error);

    await expect(handler.execute({ commit: HEAD })).resolves.toEqual({ status });
  });

  it('does not hide an unexpected error', async () => {
    await connected();
    git.listTreeAtCommit.mockRejectedValueOnce(new Error('boom'));

    await expect(handler.execute({ commit: HEAD })).rejects.toThrow('boom');
  });
});
