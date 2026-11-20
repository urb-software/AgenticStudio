import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { FailInterruptedClonesHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const URL = 'https://github.com/acme/shop.git';
const COMMIT = 'b'.repeat(40);

describe('FailInterruptedClonesHandler', () => {
  let connections: InMemoryRepositoryConnectionRepository;
  let handler: FailInterruptedClonesHandler;

  beforeEach(() => {
    connections = new InMemoryRepositoryConnectionRepository();
    handler = new FailInterruptedClonesHandler(connections);
  });

  it('fails every connecting Repository as interrupted, idempotently', async () => {
    await connections.connect({
      projectId: PROJECT,
      url: URL,
      identity: 'github.com/acme/shop',
      integrationBranch: 'dev',
    });
    const other = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    await connections.connect({
      projectId: other,
      url: 'https://github.com/acme/ready.git',
      identity: 'github.com/acme/ready',
      integrationBranch: 'dev',
    });
    await connections.change(other, (r) => {
      r.completeClone({ headSha: COMMIT, fetchedAt: new Date() });
    });

    await handler.execute();
    await handler.execute();

    expect((await connections.find(PROJECT))?.failure).toEqual({
      code: 'interrupted',
      detail: '',
      remoteDefaultBranch: null,
    });
    expect((await connections.find(other))?.state).toBe('ready');
  });
});
