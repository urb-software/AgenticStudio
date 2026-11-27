import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { StartRunHandler } from '../../../../../application/features/start-run/handler.js';
import {
  AgentNotChosenError,
  WorkflowNotUsableError,
  WorkflowUnknownError,
} from '../../../../../domain/errors/run-errors.js';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import { StartRunEndpoint } from '../endpoint.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

const startWith = async (body: unknown, outcome: unknown) => {
  const seen: unknown[] = [];
  const handler = {
    execute: (input: unknown) => {
      seen.push(input);
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  } as unknown as StartRunHandler;
  let value: unknown;
  let error: unknown;
  try {
    value = await new StartRunEndpoint(handler).start(PROJECT, body);
  } catch (caught) {
    error = caught;
  }
  return { seen, value, error };
};

describe('POST /api/projects/:id/runs with a Workflow', () => {
  it('starts with the Workflow name and answers the new Run', async () => {
    const { seen, value } = await startWith(
      { task: 'Add a health check', workflow: 'ship' },
      { id: 'run-1' },
    );

    expect(value).toEqual({ id: 'run-1' });
    expect(seen).toEqual([{ projectId: PROJECT, task: 'Add a health check', workflow: 'ship' }]);
  });

  it('answers 409 workflow_unknown for a Workflow no folder has', async () => {
    const { error } = await startWith(
      { task: 'x', workflow: 'nope' },
      new WorkflowUnknownError('nope'),
    );

    expect(error).toBeInstanceOf(ProblemException);
    const problem = error as ProblemException;
    expect(problem.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(problem.problem).toMatchObject({
      type: 'urn:agentic-studio:problem:workflow-unknown',
      extensions: { reason: 'workflow_unknown' },
    });
  });

  it('answers 409 workflow_not_usable with the reason', async () => {
    const reason = 'review Phases and Checkpoints are not supported yet';

    const { error } = await startWith(
      { task: 'x', workflow: 'ship' },
      new WorkflowNotUsableError(reason),
    );

    const problem = error as ProblemException;
    expect(problem.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(problem.problem).toMatchObject({
      type: 'urn:agentic-studio:problem:workflow-not-usable',
      extensions: { reason: 'workflow_not_usable' },
    });
    expect(problem.problem.detail).toContain(reason);
  });

  it.each([
    ['both an agent and a Workflow', { task: 'x', agent: 'a', workflow: 'w' }, 'workflow'],
    ['a Workflow with a provider', { task: 'x', workflow: 'w', provider: 'codex' }, 'provider'],
  ])('answers 422 for %s, starting nothing', async (_case, body, path) => {
    const { seen, error } = await startWith(body, { id: 'never' });

    const problem = error as ProblemException;
    expect(problem.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(problem.problem.errors?.map((entry) => entry.path)).toContain(path);
    expect(seen).toEqual([]);
  });

  it('answers 422 when nothing is named and the project has no default', async () => {
    const { error } = await startWith({ task: 'x' }, new AgentNotChosenError());

    expect((error as ProblemException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });
});
