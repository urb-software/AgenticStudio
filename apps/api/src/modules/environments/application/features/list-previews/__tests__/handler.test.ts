import { describe, expect, it } from 'vitest';
import { InMemoryPreviewOperationRepository } from '../../../../domain/repositories/__tests__/in-memory-preview-operation-repository.js';
import { seedBuild } from '../../../__tests__/preview-test-kit.js';
import { ListPreviewsHandler } from '../handler.js';

const A = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const C = 'c0000000-0000-4000-8000-000000000003';

describe('ListPreviewsHandler', () => {
  it('lists the limit and the Projects that run or build, and no one else', async () => {
    const operations = new InMemoryPreviewOperationRepository();
    await seedBuild(operations, A, '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10', 'succeeded');
    await seedBuild(operations, B, '1c3a7e63-4e1c-4e7f-9b55-7c4d2e9a3b21', 'requested');
    await seedBuild(operations, C, '2d4b8f74-5f2d-4f80-8c66-8d5e3f0b4c32', 'failed');

    await expect(new ListPreviewsHandler(operations, { maxRunning: 3 }).execute()).resolves.toEqual(
      {
        limit: 3,
        previews: [
          { projectId: A, state: 'running' },
          { projectId: B, state: 'building' },
        ],
      },
    );
  });

  it('lists nothing when no Preview runs', async () => {
    await expect(
      new ListPreviewsHandler(new InMemoryPreviewOperationRepository(), {
        maxRunning: 1,
      }).execute(),
    ).resolves.toEqual({ limit: 1, previews: [] });
  });
});
