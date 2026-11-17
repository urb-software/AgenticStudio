import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { GetRepositoryOperationHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const COMMIT = 'a'.repeat(40);

describe('GetRepositoryOperationHandler', () => {
  let projects: InMemoryProjectRepository;
  let connections: InMemoryRepositoryConnectionRepository;
  let handler: GetRepositoryOperationHandler;

  async function connecting() {
    await connections.connect({
      projectId: PROJECT,
      url: 'https://github.com/acme/shop.git',
      identity: 'github.com/acme/shop',
      integrationBranch: 'dev',
    });
  }

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
    projects.addProject(PROJECT, 'Shop');
    handler = new GetRepositoryOperationHandler(connections);
  });

  it('is the clone for a connecting Repository', async () => {
    await connecting();

    await expect(handler.execute({ projectId: PROJECT })).resolves.toBe('clone');
  });

  it('is the fetch for a fetching Repository', async () => {
    await connecting();
    await connections.change(PROJECT, (r) => {
      r.completeClone({ headSha: COMMIT, fetchedAt: new Date() });
    });
    await connections.change(PROJECT, (r) => {
      r.startFetch();
    });

    await expect(handler.execute({ projectId: PROJECT })).resolves.toBe('fetch');
  });

  it('is nothing for a Repository that is neither connecting nor fetching, or none', async () => {
    await expect(handler.execute({ projectId: PROJECT })).resolves.toBeNull();
    await connecting();
    await connections.change(PROJECT, (r) => {
      r.completeClone({ headSha: COMMIT, fetchedAt: new Date() });
    });
    await expect(handler.execute({ projectId: PROJECT })).resolves.toBeNull();
    await connections.change(PROJECT, (r) => {
      r.startDisconnect();
    });
    await expect(handler.execute({ projectId: PROJECT })).resolves.toBeNull();
  });
});
