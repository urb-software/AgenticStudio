import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { GetPreviewSourceStatusHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

describe('GetPreviewSourceStatusHandler', () => {
  let projects: InMemoryProjectRepository;
  let connections: InMemoryRepositoryConnectionRepository;
  let git: FakeRepositoryGit;
  let handler: GetPreviewSourceStatusHandler;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
    git = new FakeRepositoryGit();
    handler = new GetPreviewSourceStatusHandler(projects, connections, git);
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

  it('walks from an unknown project to a ready Repository', async () => {
    await expect(handler.execute({ projectId: 'nope' })).resolves.toEqual({
      status: 'project_not_found',
    });
    await expect(handler.execute({ projectId: PROJECT })).resolves.toEqual({
      status: 'project_not_found',
    });
    projects.addProject(PROJECT, 'Shop');
    await expect(handler.execute({ projectId: PROJECT })).resolves.toEqual({
      status: 'no_repository',
    });
    await connect();
    await expect(handler.execute({ projectId: PROJECT })).resolves.toEqual({
      status: 'repository_not_ready',
    });
    await connections.change(PROJECT, (r) => {
      r.completeClone({ headSha: 'c'.repeat(40), fetchedAt: new Date() });
    });
    await expect(handler.execute({ projectId: PROJECT })).resolves.toEqual({
      status: 'ready',
      commit: 'c'.repeat(40),
    });
  });

  it('is unsupported on a host that is not Linux, even with a ready Repository', async () => {
    await connect();
    await connections.change(PROJECT, (r) => {
      r.completeClone({ headSha: 'c'.repeat(40), fetchedAt: new Date() });
    });
    git.supported = false;

    await expect(handler.execute({ projectId: PROJECT })).resolves.toEqual({
      status: 'unsupported_platform',
    });
  });
});
