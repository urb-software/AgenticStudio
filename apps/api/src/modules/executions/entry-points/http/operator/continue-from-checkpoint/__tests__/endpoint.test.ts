import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { ContinueFromCheckpointHandler } from '../../../../../application/features/continue-from-checkpoint/handler.js';
import type { GetRunHandler } from '../../../../../application/features/get-run/handler.js';
import {
  RunNotAtCheckpointError,
  RunNotFoundError,
} from '../../../../../domain/errors/run-errors.js';
import {
  FieldProblemException,
  ProblemException,
} from '../../../../../../../platform/http/problem-details.js';
import { ContinueFromCheckpointEndpoint } from '../endpoint.js';

const RUN = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

const continueWith = async (body: unknown, outcome?: Error) => {
  const seen: unknown[] = [];
  const handler = {
    execute: (input: unknown) => {
      seen.push(input);
      return outcome ? Promise.reject(outcome) : Promise.resolve();
    },
  } as unknown as ContinueFromCheckpointHandler;
  // Never reached when the command is refused; a Run answer is the GET route's own test.
  const getRun = {
    execute: () => Promise.reject(new RunNotFoundError()),
  } as unknown as GetRunHandler;
  let error: unknown;
  try {
    await new ContinueFromCheckpointEndpoint(handler, getRun).continue(RUN, body);
  } catch (caught) {
    error = caught;
  }
  return { seen, error };
};

describe('POST /api/runs/:runId/checkpoint/continue', () => {
  it('hands the comment and the Checkpoint the operator saw to the command, trimmed', async () => {
    const { seen } = await continueWith({ comment: '  Use the small plan.  ', checkpoint: 'look' });

    expect(seen).toEqual([{ runId: RUN, comment: 'Use the small plan.', checkpoint: 'look' }]);
  });

  it('needs no body: the comment is optional', async () => {
    const { seen } = await continueWith(undefined);

    expect(seen).toEqual([{ runId: RUN }]);
  });

  it('takes a comment of 4,000 characters and refuses one of 4,001 with 422, starting nothing', async () => {
    const accepted = await continueWith({ comment: 'x'.repeat(4000) });
    expect(accepted.seen).toHaveLength(1);

    const refused = await continueWith({ comment: 'x'.repeat(4001) });
    expect(refused.seen).toEqual([]);
    expect(refused.error).toBeInstanceOf(FieldProblemException);
    expect((refused.error as FieldProblemException).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect((refused.error as FieldProblemException).problem.errors).toEqual([
      { path: 'comment', message: 'Use at most 4000 characters.' },
    ]);
  });

  it('refuses a body with anything else in it with 422', async () => {
    const { seen, error } = await continueWith({ comment: 'ok', next: 'phase-2' });

    expect(seen).toEqual([]);
    expect(error).toBeInstanceOf(FieldProblemException);
  });

  it('answers 409 not_at_checkpoint when the Run does not wait at a Checkpoint', async () => {
    const { error } = await continueWith({}, new RunNotAtCheckpointError('queued'));

    const problem = error as ProblemException;
    expect(problem.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(problem.problem).toMatchObject({
      type: 'urn:agentic-studio:problem:run-not-at-checkpoint',
      extensions: { reason: 'not_at_checkpoint' },
    });
  });

  it('answers 404 for an unknown Run', async () => {
    const { error } = await continueWith({}, new RunNotFoundError());

    expect((error as ProblemException).getStatus()).toBe(HttpStatus.NOT_FOUND);
  });
});
