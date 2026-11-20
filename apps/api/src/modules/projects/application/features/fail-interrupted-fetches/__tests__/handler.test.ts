import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { FailInterruptedFetchesHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const URL = 'https://github.com/acme/shop.git';
const OLD = 'a'.repeat(40);
const FETCHED_AT = new Date('2026-11-13T10:00:00.000Z');

describe('FailInterruptedFetchesHandler', () => {
  let connections: InMemoryRepositoryConnectionRepository;
  let handler: FailInterruptedFetchesHandler;
  const stored = () => connections.find(PROJECT);

  async function fetching() {
    await connections.connect({
      projectId: PROJECT,
      url: URL,
      identity: 'github.com/acme/shop',
      integrationBranch: 'dev',
    });
    await connections.change(PROJECT, (r) => {
      r.completeClone({ headSha: OLD, fetchedAt: FETCHED_AT });
    });
    await connections.change(PROJECT, (r) => {
      r.startFetch();
    });
  }

  beforeEach(() => {
    const projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
    projects.addProject(PROJECT, 'Shop');
    handler = new FailInterruptedFetchesHandler(connections);
  });

  it('fails every fetching Repository as interrupted with its Clone kept, idempotently', async () => {
    await fetching();

    await handler.execute();
    await handler.execute();

    expect(await stored()).toMatchObject({
      state: 'failed',
      hasClone: true,
      headSha: OLD,
      failure: { code: 'interrupted', detail: '', remoteDefaultBranch: null },
    });
  });
});
