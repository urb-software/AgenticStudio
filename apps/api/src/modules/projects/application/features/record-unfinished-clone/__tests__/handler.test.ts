import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { UNEXPECTED_FAILURE_DETAIL } from '../../../../domain/value-objects/repository-failure.js';
import { RecordUnfinishedCloneHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const URL = 'https://github.com/acme/shop.git';

describe('RecordUnfinishedCloneHandler', () => {
  let connections: InMemoryRepositoryConnectionRepository;
  let handler: RecordUnfinishedCloneHandler;

  async function connecting() {
    await connections.connect({
      projectId: PROJECT,
      url: URL,
      identity: 'github.com/acme/shop',
      integrationBranch: 'dev',
    });
  }

  beforeEach(() => {
    const projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
    projects.addProject(PROJECT, 'Shop');
    handler = new RecordUnfinishedCloneHandler(connections);
  });

  it.each([
    ['stalled', { code: 'interrupted', detail: '' }],
    ['shutdown', { code: 'interrupted', detail: '' }],
    ['cancelled', { code: 'unknown', detail: 'Cancelled' }],
    ['timeout', { code: 'timeout' }],
  ] as const)('stores %s as %j', async (reason, failure) => {
    await connecting();

    await handler.execute({ projectId: PROJECT, failure: { reason } });

    expect((await connections.find(PROJECT))?.failure).toMatchObject(failure);
  });

  it('stores an unexpected error as unknown with a generic detail, never the error', async () => {
    await connecting();

    await handler.execute({
      projectId: PROJECT,
      failure: { reason: 'error', error: new Error('db down at 10.0.0.7') },
    });

    expect((await connections.find(PROJECT))?.failure).toEqual({
      code: 'unknown',
      detail: UNEXPECTED_FAILURE_DETAIL,
      remoteDefaultBranch: null,
    });
  });
});
