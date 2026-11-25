import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { GetDefinitionsRepositoryHandler } from '../handler.js';

const CODE = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const DEFINITIONS = '4a3c9d2f-5e6b-4c7d-8e8f-9a0b1c2d3e4f';
const SHA = 'a'.repeat(40);

describe('GetDefinitionsRepositoryHandler', () => {
  let projects: InMemoryProjectRepository;
  let connections: InMemoryRepositoryConnectionRepository;
  let handler: GetDefinitionsRepositoryHandler;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
    handler = new GetDefinitionsRepositoryHandler(projects, connections);
  });

  it('answers null while only ordinary Projects exist', async () => {
    projects.addProject(CODE, 'Shop');

    await expect(handler.execute()).resolves.toBeNull();
  });

  it('answers the Project with no Repository before one is connected', async () => {
    projects.addProject(CODE, 'Shop');
    projects.addProject(DEFINITIONS, 'Agents', 'definitions');

    await expect(handler.execute()).resolves.toEqual({
      projectId: DEFINITIONS,
      repository: null,
    });
  });

  it('answers the connection state, the Integration branch and the last fetched commit', async () => {
    projects.addProject(DEFINITIONS, 'Agents', 'definitions');
    await connections.connect({
      projectId: DEFINITIONS,
      url: 'https://github.com/acme/agents.git',
      identity: 'github.com/acme/agents',
      integrationBranch: 'main',
    });
    const fetchedAt = new Date('2026-11-25T10:00:00.000Z');
    await connections.change(DEFINITIONS, (repository) => {
      repository.completeClone({ headSha: SHA, fetchedAt });
    });

    await expect(handler.execute()).resolves.toEqual({
      projectId: DEFINITIONS,
      repository: {
        state: 'ready',
        integrationBranch: 'main',
        headSha: SHA,
        lastFetchedAt: fetchedAt,
      },
    });
  });
});
