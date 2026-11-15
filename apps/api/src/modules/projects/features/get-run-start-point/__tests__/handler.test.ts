import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { GetRunStartPointHandler } from '../handler.js';

// Issue #96: the commit a Run starts from, offered to `executions` through the public
// contracts/index.ts of `projects`.
const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const HEAD = 'c'.repeat(40);

describe('GetRunStartPointHandler', () => {
  let projects: InMemoryProjectRepository;
  let handler: GetRunStartPointHandler;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    handler = new GetRunStartPointHandler(projects);
  });

  async function connect() {
    projects.addProject(PROJECT, 'Shop');
    await projects.beginConnect({
      projectId: PROJECT,
      url: 'https://github.com/acme/shop.git',
      identity: 'github.com/acme/shop',
      integrationBranch: 'dev',
    });
  }

  it('starts from the integration branch commit of a ready Repository, at its remote', async () => {
    await connect();
    await projects.markReady(PROJECT, { headSha: HEAD, fetchedAt: new Date() });

    // Issue #98: the remote URL as the operator connected it, so the agent worker can fetch it.
    expect(await handler.forProject(PROJECT)).toEqual({
      status: 'ready',
      startCommit: HEAD,
      remoteUrl: 'https://github.com/acme/shop.git',
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

    await projects.markReady(PROJECT, { headSha: HEAD, fetchedAt: new Date() });
    await projects.beginFetch(PROJECT);
    expect(await handler.forProject(PROJECT)).toEqual({ status: 'repository_not_ready' });
  });
});
