import { describe, expect, it } from 'vitest';
import type {
  DefinitionsRepositories,
  DefinitionsRepositoryState,
} from '../../../../../projects/contracts/index.js';
import { GetDefinitionsRepositoryHandler } from '../handler.js';

const PROJECT = '4a3c9d2f-5e6b-4c7d-8e8f-9a0b1c2d3e4f';

function answering(current: DefinitionsRepositoryState | null) {
  const definitions: DefinitionsRepositories = { current: () => Promise.resolve(current) };
  return new GetDefinitionsRepositoryHandler(definitions);
}

describe('GetDefinitionsRepositoryHandler', () => {
  it('answers no Project while none is connected', async () => {
    await expect(answering(null).execute()).resolves.toEqual({ project: null });
  });

  it('answers the Project with no Repository before one is connected', async () => {
    await expect(answering({ projectId: PROJECT, repository: null }).execute()).resolves.toEqual({
      project: { id: PROJECT, repository: null },
    });
  });

  it('answers the state, the Integration branch and the last fetched commit', async () => {
    const repository = {
      state: 'ready',
      integrationBranch: 'main',
      headSha: 'a'.repeat(40),
      lastFetchedAt: new Date('2026-11-25T10:00:00.000Z'),
    } as const;

    await expect(answering({ projectId: PROJECT, repository }).execute()).resolves.toEqual({
      project: { id: PROJECT, repository },
    });
  });
});
