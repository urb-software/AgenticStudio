import { describe, expect, it, vi } from 'vitest';
import type { ReadWorkflowsHandler } from '../../../../../application/features/read-workflows/handler.js';
import { ListWorkflowsEndpoint } from '../endpoint.js';
import { workflowListResponseSchema } from '../schema.js';

const COMMIT = 'a'.repeat(40);

const endpointFor = (result: unknown) => {
  const execute = vi.fn(() => Promise.resolve(result));
  return new ListWorkflowsEndpoint({ execute } as unknown as ReadWorkflowsHandler);
};

describe('ListWorkflowsEndpoint', () => {
  it('answers the commit and each Workflow with its state, without items', async () => {
    const endpoint = endpointFor({
      commit: COMMIT,
      repository: { state: 'ready', note: null },
      truncated: false,
      workflows: [
        {
          name: 'ship',
          description: 'Build, then review',
          valid: true,
          usable: true,
          notUsableReason: null,
          problems: [],
          sendBacks: 2,
          items: [{ kind: 'checkpoint', id: 'ask', text: 'x' }],
        },
        {
          name: 'broken',
          description: null,
          valid: false,
          usable: false,
          notUsableReason: null,
          problems: [{ code: 'no_phase', path: 'WORKFLOW.md', key: 'sequence', message: 'None.' }],
          sendBacks: null,
          items: [],
        },
      ],
    });

    const answer = await endpoint.list();

    expect(workflowListResponseSchema.parse(answer)).toEqual(answer);
    expect(answer.workflows).toEqual([
      {
        name: 'ship',
        description: 'Build, then review',
        valid: true,
        usable: true,
        notUsableReason: null,
        problems: [],
      },
      {
        name: 'broken',
        description: null,
        valid: false,
        usable: false,
        notUsableReason: null,
        problems: [{ code: 'no_phase', path: 'WORKFLOW.md', key: 'sequence', message: 'None.' }],
      },
    ]);
  });

  it('answers a null commit and repository when none is connected', async () => {
    const endpoint = endpointFor({
      commit: null,
      repository: null,
      truncated: false,
      workflows: [],
    });

    const answer = await endpoint.list();

    expect(workflowListResponseSchema.parse(answer)).toEqual(answer);
    expect(answer).toEqual({ commit: null, repository: null, truncated: false, workflows: [] });
  });

  it('says when the list was cut', async () => {
    const endpoint = endpointFor({
      commit: COMMIT,
      repository: { state: 'fetching', note: 'A fetch is running.' },
      truncated: true,
      workflows: [],
    });

    await expect(endpoint.list()).resolves.toMatchObject({
      truncated: true,
      repository: { state: 'fetching', note: 'A fetch is running.' },
    });
  });
});
