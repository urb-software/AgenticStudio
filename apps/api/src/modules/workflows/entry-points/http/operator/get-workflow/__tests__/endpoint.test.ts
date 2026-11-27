import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import type { ReadWorkflowHandler } from '../../../../../application/features/read-workflow/handler.js';
import { WORKFLOWS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { GetWorkflowEndpoint } from '../endpoint.js';
import { workflowDetailResponseSchema } from '../schema.js';

const COMMIT = 'a'.repeat(40);
const repository = { state: 'ready' as const, note: null };

const workflow = {
  name: 'ship',
  description: 'Build, then review',
  valid: true,
  usable: false,
  notUsableReason: 'The phase "check" uses Codex, which is not available.',
  problems: [],
  sendBacks: 2,
  items: [
    {
      kind: 'work' as const,
      id: 'build',
      agent: 'builder',
      agentState: 'valid' as const,
      provider: 'claude_code' as const,
      usable: true,
    },
    { kind: 'checkpoint' as const, id: 'ask', text: '<b>Look</b>\nbefore going on' },
    {
      kind: 'review' as const,
      id: 'check',
      agent: 'reviewer',
      agentState: 'valid' as const,
      provider: 'codex' as const,
      usable: false,
    },
  ],
};

const endpointFor = (found: unknown) => {
  const execute = vi.fn(() => Promise.resolve({ commit: COMMIT, repository, workflow: found }));
  return {
    execute,
    endpoint: new GetWorkflowEndpoint({ execute } as unknown as ReadWorkflowHandler),
  };
};

const notFound = async (promise: Promise<unknown>) => {
  const error = (await promise.catch((caught: unknown) => caught)) as ProblemException;
  expect(error).toBeInstanceOf(ProblemException);
  expect(error.getStatus()).toBe(404);
  expect(error.problem.type).toBe(WORKFLOWS_PROBLEM_TYPES.workflowNotFound);
};

describe('GetWorkflowEndpoint', () => {
  it('answers one Workflow with its items in order and the send-back limit', async () => {
    const { endpoint, execute } = endpointFor(workflow);

    const answer = await endpoint.get('ship');

    expect(workflowDetailResponseSchema.parse(answer)).toEqual(answer);
    expect(answer).toEqual({ commit: COMMIT, repository, ...workflow });
    expect(execute).toHaveBeenCalledWith({ name: 'ship' });
  });

  it('answers the problems of an invalid Workflow, with a null key where none applies', async () => {
    const { endpoint } = endpointFor({
      ...workflow,
      description: null,
      valid: false,
      usable: false,
      notUsableReason: null,
      sendBacks: null,
      items: [],
      problems: [{ code: 'entry_missing', path: 'WORKFLOW.md', message: 'No entry file.' }],
    });

    const answer = await endpoint.get('ship');

    expect(workflowDetailResponseSchema.parse(answer)).toEqual(answer);
    expect(answer).toMatchObject({
      valid: false,
      sendBacks: null,
      items: [],
      problems: [
        { code: 'entry_missing', path: 'WORKFLOW.md', key: null, message: 'No entry file.' },
      ],
    });
  });

  it('answers 404 for an unknown name', async () => {
    const { endpoint } = endpointFor(null);

    await notFound(endpoint.get('nope'));
  });

  it.each(['A', 'a b', '../x', 'a/b', '%2e%2e', '<script>', '-a', 'a'.repeat(65), ''])(
    'answers 404 for the name %j without reading anything',
    async (name) => {
      const { endpoint, execute } = endpointFor(workflow);

      await notFound(endpoint.get(name));
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
