import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { GetRunStartPointHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const HEAD = 'c'.repeat(40);

describe('GetRunStartPointHandler', () => {
  let projects: InMemoryProjectRepository;
  let connections: InMemoryRepositoryConnectionRepository;
  let handler: GetRunStartPointHandler;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
    handler = new GetRunStartPointHandler(projects, connections);
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

  it('starts from the integration branch commit of a ready Repository, at its remote', async () => {
    await connect();
    await connections.change(PROJECT, (r) => {
      r.completeClone({ headSha: HEAD, fetchedAt: new Date() });
    });

    expect(await handler.forProject(PROJECT)).toEqual({
      status: 'ready',
      startCommit: HEAD,
      remoteUrl: 'https://github.com/acme/shop.git',
      integrationBranch: 'dev',
    });
  });

  it('names an unknown project, also for an id that is not a UUID', async () => {
    expect(await handler.forProject(PROJECT)).toEqual({ status: 'project_not_found' });
    expect(await handler.forProject('not-a-uuid')).toEqual({ status: 'project_not_found' });
  });

  it('names a project without a Repository', async () => {
    projects.addProject(PROJECT, 'Shop');

    expect(await handler.forProject(PROJECT)).toEqual({ status: 'no_repository' });
  });

  it('refuses a Repository that is not ready, even one being fetched', async () => {
    await connect();
    expect(await handler.forProject(PROJECT)).toEqual({ status: 'repository_not_ready' });

    await connections.change(PROJECT, (r) => {
      r.completeClone({ headSha: HEAD, fetchedAt: new Date() });
    });
    await connections.change(PROJECT, (r) => {
      r.startFetch();
    });
    expect(await handler.forProject(PROJECT)).toEqual({ status: 'repository_not_ready' });
  });
});
