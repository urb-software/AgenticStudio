import { previewsListSchema } from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import type { ListPreviewsHandler } from '../../../../../application/features/list-previews/handler.js';
import { ListPreviewsEndpoint } from '../endpoint.js';

const A = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

describe('ListPreviewsEndpoint', () => {
  it('answers the limit and the Projects that take a place, in the contract shape', async () => {
    const handler = {
      execute: () =>
        Promise.resolve({ limit: 3, previews: [{ projectId: A, state: 'running' as const }] }),
    };

    const answer = await new ListPreviewsEndpoint(handler as unknown as ListPreviewsHandler).list();

    expect(previewsListSchema.safeParse(answer).success).toBe(true);
    expect(answer).toEqual({ limit: 3, previews: [{ projectId: A, state: 'running' }] });
  });
});
