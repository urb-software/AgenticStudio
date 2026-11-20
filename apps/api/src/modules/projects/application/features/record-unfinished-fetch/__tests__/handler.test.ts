import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { UNEXPECTED_FAILURE_DETAIL } from '../../../../domain/value-objects/repository-failure.js';
import { RecordUnfinishedFetchHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const URL = 'https://github.com/acme/shop.git';
const OLD = 'a'.repeat(40);
const FETCHED_AT = new Date('2026-11-13T10:00:00.000Z');

describe('RecordUnfinishedFetchHandler', () => {
  let connections: InMemoryRepositoryConnectionRepository;
  let handler: RecordUnfinishedFetchHandler;
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
    connections = new InMemoryRepositoryConnectionRepository();
    handler = new RecordUnfinishedFetchHandler(connections);
  });

  it.each([
    ['stalled', { code: 'interrupted', detail: '' }],
    ['shutdown', { code: 'interrupted', detail: '' }],
    ['cancelled', { code: 'unknown', detail: 'Cancelled' }],
    ['timeout', { code: 'timeout', detail: 'The fetch took too long and was stopped.' }],
    ['error', { code: 'unknown', detail: UNEXPECTED_FAILURE_DETAIL }],
  ] as const)('stores %s as %j and keeps the Clone', async (reason, failure) => {
    await fetching();

    await handler.execute({
      projectId: PROJECT,
      failure: reason === 'error' ? { reason, error: new Error('db down') } : { reason },
    });

    expect(await stored()).toMatchObject({
      state: 'failed',
      hasClone: true,
      headSha: OLD,
      lastFetchedAt: FETCHED_AT,
      failure,
    });
  });
});
