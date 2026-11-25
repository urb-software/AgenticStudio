import { beforeEach, describe, expect, it } from 'vitest';
import type { DefinitionsPublishInput } from '../../../../contracts/index.js';
import { NoTrustedHostKeyError } from '../../../../domain/errors/repository-connection-errors.js';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import {
  GitCloneMissingError,
  GitCommitMissingError,
  GitNothingToCommitError,
  GitOperationError,
  GitProjectNotWritableError,
  GitRemoteMovedError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
  GitWriteRefusedError,
} from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { InMemoryDeployKeys } from '../../../ports/__tests__/in-memory-deploy-keys.js';
import { InMemorySecretStore } from '../../../ports/__tests__/in-memory-secret-store.js';
import { PublishDefinitionsHandler } from '../handler.js';

const CODE = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const DEFINITIONS = '4a3c9d2f-5e6b-4c7d-8e8f-9a0b1c2d3e4f';
const URL = 'https://github.com/acme/agents.git';
const BASE = 'a'.repeat(40);
const PUBLISHED = 'b'.repeat(40);
const FETCHED_AT = new Date('2026-11-25T09:00:00.000Z');

const input = (overrides: Partial<DefinitionsPublishInput> = {}): DefinitionsPublishInput => ({
  baseCommit: BASE,
  changes: [{ path: 'agents/a/AGENT.md', content: new Uint8Array([1, 2]), executable: false }],
  message: 'Publish a',
  identity: { name: 'Studio Publisher', email: 'studio@example.test' },
  ...overrides,
});

describe('PublishDefinitionsHandler', () => {
  let projects: InMemoryProjectRepository;
  let connections: InMemoryRepositoryConnectionRepository;
  let git: FakeRepositoryGit;
  let handler: PublishDefinitionsHandler;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
    git = new FakeRepositoryGit();
    git.publishCommit.mockResolvedValue({ commit: PUBLISHED });
    handler = new PublishDefinitionsHandler(
      projects,
      connections,
      git,
      new InMemoryDeployKeys(new InMemorySecretStore()),
    );
  });

  async function connected(projectId = DEFINITIONS, kind: 'code' | 'definitions' = 'definitions') {
    projects.addProject(projectId, 'Agents', kind);
    await connections.connect({
      projectId,
      url: URL,
      identity: 'github.com/acme/agents',
      integrationBranch: 'dev',
    });
    await connections.change(projectId, (r) => {
      r.completeClone({ headSha: BASE, fetchedAt: FETCHED_AT });
    });
  }

  it('publishes on the Integration branch from the base the Clone holds, then moves the Clone on', async () => {
    await connected();

    await expect(handler.execute(input())).resolves.toEqual({
      status: 'published',
      commit: PUBLISHED,
    });

    expect(git.publishCommit).toHaveBeenCalledTimes(1);
    expect(git.publishCommit).toHaveBeenCalledWith(
      DEFINITIONS,
      URL,
      {
        branch: 'dev',
        baseCommit: BASE,
        changes: input().changes,
        message: 'Publish a',
        identity: { name: 'Studio Publisher', email: 'studio@example.test' },
      },
      { ssh: undefined },
    );
    expect(await connections.find(DEFINITIONS)).toMatchObject({
      state: 'ready',
      headSha: PUBLISHED,
      lastFetchedAt: FETCHED_AT,
    });
  });

  it('writes to no other Project, whatever its kind or Repository', async () => {
    await connected(CODE, 'code');

    await expect(handler.execute(input())).resolves.toEqual({ status: 'repository_not_ready' });

    expect(git.publishCommit).not.toHaveBeenCalled();
    expect(await connections.find(CODE)).toMatchObject({ headSha: BASE });
  });

  it('refuses without a definitions Project and without its Repository', async () => {
    await expect(handler.execute(input())).resolves.toEqual({ status: 'repository_not_ready' });
    projects.addProject(DEFINITIONS, 'Agents', 'definitions');
    await expect(handler.execute(input())).resolves.toEqual({ status: 'repository_not_ready' });

    expect(git.publishCommit).not.toHaveBeenCalled();
  });

  it('refuses a Repository that is fetching: the Clone is about to change', async () => {
    await connected();
    await connections.change(DEFINITIONS, (r) => {
      r.startFetch();
    });

    await expect(handler.execute(input())).resolves.toEqual({ status: 'repository_not_ready' });

    expect(git.publishCommit).not.toHaveBeenCalled();
  });

  it('answers that the Repository moved when the Clone is not at the base, before it asks Git', async () => {
    await connected();

    await expect(handler.execute(input({ baseCommit: 'c'.repeat(40) }))).resolves.toEqual({
      status: 'repository_moved',
    });

    expect(git.publishCommit).not.toHaveBeenCalled();
  });

  it.each([
    ['the remote having moved', new GitRemoteMovedError(), 'repository_moved'],
    ['a base the Clone lacks', new GitCommitMissingError(), 'repository_moved'],
    ['a refused write', new GitWriteRefusedError(), 'write_refused'],
    ['no change', new GitNothingToCommitError(), 'nothing_to_publish'],
    ['a missing Clone', new GitCloneMissingError(), 'repository_not_ready'],
    [
      'a platform that is not Linux',
      new GitUnsupportedPlatformError('win32'),
      'unsupported_platform',
    ],
    ['a Project that is not writable', new GitProjectNotWritableError(), 'failed'],
    ['a rejected request', new GitRequestRejectedError('x'), 'failed'],
    ['another Git failure', new GitOperationError('host_unreachable', 'detail'), 'failed'],
  ])('answers %s as %s, leaving the Clone commit as it was', async (_name, error, status) => {
    await connected();
    git.publishCommit.mockRejectedValueOnce(error);

    await expect(handler.execute(input())).resolves.toEqual({ status });

    expect(await connections.find(DEFINITIONS)).toMatchObject({ headSha: BASE, state: 'ready' });
  });

  it('answers failed when no host key is trusted, without asking Git', async () => {
    await connected();
    const refused = new PublishDefinitionsHandler(projects, connections, git, {
      credentials: () => Promise.reject(new NoTrustedHostKeyError()),
    } as never);

    await expect(refused.execute(input())).resolves.toEqual({ status: 'failed' });

    expect(git.publishCommit).not.toHaveBeenCalled();
  });

  it('lets an unexpected error through', async () => {
    await connected();
    git.publishCommit.mockRejectedValueOnce(new Error('boom'));

    await expect(handler.execute(input())).rejects.toThrow('boom');
  });

  it('still answers the commit when the Repository changed state during the push', async () => {
    await connected();
    git.publishCommit.mockImplementationOnce(async () => {
      await connections.change(DEFINITIONS, (r) => {
        r.startFetch();
      });
      return { commit: PUBLISHED };
    });

    await expect(handler.execute(input())).resolves.toEqual({
      status: 'published',
      commit: PUBLISHED,
    });
    // The fetch that follows brings the Clone's commit; nothing here overwrites it.
    expect(await connections.find(DEFINITIONS)).toMatchObject({ state: 'fetching', headSha: BASE });
  });
});
