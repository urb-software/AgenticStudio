import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { GetRunHandler } from '../../../../../application/features/get-run/handler.js';
import type { StopAtCheckpointHandler } from '../../../../../application/features/stop-at-checkpoint/handler.js';
import {
  RunNotAtCheckpointError,
  RunNotFoundError,
} from '../../../../../domain/errors/run-errors.js';
import {
  FieldProblemException,
  ProblemException,
} from '../../../../../../../platform/http/problem-details.js';
import { StopAtCheckpointEndpoint } from '../endpoint.js';

const RUN = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

const stopWith = async (body: unknown, outcome?: Error) => {
  const seen: unknown[] = [];
  const handler = {
    execute: (input: unknown) => {
      seen.push(input);
      return outcome ? Promise.reject(outcome) : Promise.resolve();
    },
  } as unknown as StopAtCheckpointHandler;
  const getRun = {
    execute: () => Promise.reject(new RunNotFoundError()),
  } as unknown as GetRunHandler;
  let error: unknown;
  try {
    await new StopAtCheckpointEndpoint(handler, getRun).stop(RUN, body);
  } catch (caught) {
    error = caught;
  }
  return { seen, error };
};

describe('POST /api/runs/:runId/checkpoint/stop', () => {
  it('hands the Checkpoint the operator saw to the command, and needs no body', async () => {
    expect((await stopWith({ checkpoint: 'look' })).seen).toEqual([
      { runId: RUN, checkpoint: 'look' },
    ]);
    expect((await stopWith(undefined)).seen).toEqual([{ runId: RUN }]);
  });

  it('refuses a body with anything else in it with 422, stopping nothing', async () => {
    const { seen, error } = await stopWith({ comment: 'why' });

    expect(seen).toEqual([]);
    expect(error).toBeInstanceOf(FieldProblemException);
  });

  it('answers 409 not_at_checkpoint when the Run does not wait at a Checkpoint', async () => {
    const { error } = await stopWith({}, new RunNotAtCheckpointError('cancelled'));

    const problem = error as ProblemException;
    expect(problem.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(problem.problem).toMatchObject({
      type: 'urn:agentic-studio:problem:run-not-at-checkpoint',
      extensions: { reason: 'not_at_checkpoint' },
    });
  });

  it('answers 404 for an unknown Run', async () => {
    const { error } = await stopWith({}, new RunNotFoundError());

    expect((error as ProblemException).getStatus()).toBe(HttpStatus.NOT_FOUND);
  });
});
