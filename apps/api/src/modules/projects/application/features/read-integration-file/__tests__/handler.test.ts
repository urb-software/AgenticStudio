import { beforeEach, describe, expect, it } from 'vitest';
import { INTEGRATION_FILE_MAX_BYTES } from '../../../../contracts/index.js';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import {
  GitCloneMissingError,
  GitOperationError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
} from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { ReadIntegrationFileHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const HEAD = 'c'.repeat(40);

describe('ReadIntegrationFileHandler', () => {
  let projects: InMemoryProjectRepository;
  let connections: InMemoryRepositoryConnectionRepository;
  let git: FakeRepositoryGit;
  let handler: ReadIntegrationFileHandler;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
    git = new FakeRepositoryGit();
    handler = new ReadIntegrationFileHandler(projects, connections, git);
  });

  async function connect() {
    projects.addProject(PROJECT, 'Shop');
    await connections.connect({
      projectId: PROJECT,
      url: 'https://github.com/acme/shop.git',
      identity: 'github.com/acme/shop',
      integrationBranch: 'dev',
    });
  }

  async function readyRepository() {
    await connect();
    await connections.change(PROJECT, (r) => {
      r.completeClone({ headSha: HEAD, fetchedAt: new Date() });
    });
  }

  const read = (path = 'compose.yaml') => handler.execute({ projectId: PROJECT, path });

  it('reads the file at the commit the Clone holds, within the contract limit', async () => {
    await readyRepository();
    git.readFileAtCommit.mockResolvedValueOnce({ status: 'found', text: 'services: {}\n' });

    await expect(read('deploy/compose.yaml')).resolves.toEqual({
      status: 'found',
      text: 'services: {}\n',
      commit: HEAD,
    });
    expect(git.readFileAtCommit).toHaveBeenCalledWith(
      PROJECT,
      HEAD,
      'deploy/compose.yaml',
      INTEGRATION_FILE_MAX_BYTES,
    );
  });

  it.each(['missing', 'too_large'] as const)('passes on %s', async (status) => {
    await readyRepository();
    git.readFileAtCommit.mockResolvedValueOnce({ status });

    await expect(read()).resolves.toEqual({ status });
  });

  it('names an unknown project, also for an id that is not a UUID', async () => {
    await expect(read()).resolves.toEqual({ status: 'project_not_found' });
    await expect(handler.execute({ projectId: 'nope', path: 'compose.yaml' })).resolves.toEqual({
      status: 'project_not_found',
    });
    expect(git.readFileAtCommit).not.toHaveBeenCalled();
  });

  it('is not ready without a Repository, before the clone ends and while it fetches', async () => {
    projects.addProject(PROJECT, 'Shop');
    await expect(read()).resolves.toEqual({ status: 'repository_not_ready' });
    await connect();
    await expect(read()).resolves.toEqual({ status: 'repository_not_ready' });
    await connections.change(PROJECT, (r) => {
      r.completeClone({ headSha: HEAD, fetchedAt: new Date() });
    });
    await connections.change(PROJECT, (r) => {
      r.startFetch();
    });
    await expect(read()).resolves.toEqual({ status: 'repository_not_ready' });
    expect(git.readFileAtCommit).not.toHaveBeenCalled();
  });

  it.each([
    '../x',
    '/etc/passwd',
    'a/../b',
    'a\\b',
    './compose.yaml',
    'a//b',
    '.git/config',
    '',
    'a\u0000b',
  ])('checks the path again and never asks Git for %j', async (path) => {
    await readyRepository();

    await expect(read(path)).resolves.toEqual({ status: 'failed' });
    expect(git.readFileAtCommit).not.toHaveBeenCalled();
  });

  it('turns every Git failure into an answer', async () => {
    await readyRepository();
    const answerTo = (error: Error) => {
      git.readFileAtCommit.mockRejectedValueOnce(error);
      return read();
    };

    await expect(answerTo(new GitUnsupportedPlatformError('win32'))).resolves.toEqual({
      status: 'unsupported_platform',
    });
    await expect(answerTo(new GitCloneMissingError())).resolves.toEqual({
      status: 'repository_not_ready',
    });
    await expect(answerTo(new GitOperationError('unknown'))).resolves.toEqual({
      status: 'failed',
    });
    await expect(answerTo(new GitRequestRejectedError('no'))).resolves.toEqual({
      status: 'failed',
    });
  });

  it('rethrows what it does not know', async () => {
    await readyRepository();
    git.readFileAtCommit.mockRejectedValueOnce(new TypeError('bug'));

    await expect(read()).rejects.toThrow(TypeError);
  });
});
