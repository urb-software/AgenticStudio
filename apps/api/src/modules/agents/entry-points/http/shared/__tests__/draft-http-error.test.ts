import { describe, expect, it } from 'vitest';
import {
  FieldProblemException,
  ProblemException,
} from '../../../../../../platform/http/problem-details.js';
import {
  DraftBaseMissingError,
  DraftBaseUnreadableError,
  DraftChangedConcurrentlyError,
  DraftFileNotFoundError,
  DraftMoveUnsupportedError,
  DraftNoBaseError,
  DraftPathConflictError,
  DraftPathNotWritableError,
  DraftPathTakenError,
  DraftTooLargeError,
  DraftTooManyFilesError,
} from '../../../../domain/errors/agent-draft-errors.js';
import { DraftFileTooLargeError } from '../../../../domain/value-objects/agent-draft-file-size.js';
import { InvalidAgentDraftPathError } from '../../../../domain/value-objects/agent-draft-path.js';
import { toDraftHttpError } from '../draft-http-error.js';
import { AGENTS_PROBLEM_TYPES } from '../problems.js';

function problemOf(error: unknown) {
  expect(error).toBeInstanceOf(ProblemException);
  const exception = error as ProblemException;
  return { status: exception.getStatus(), ...exception.problem };
}

describe('toDraftHttpError', () => {
  it.each([
    [new DraftFileTooLargeError(2_000_000, 1_048_576), 422, AGENTS_PROBLEM_TYPES.draftFileTooLarge],
    [new DraftTooLargeError(11_000_000, 10_485_760), 422, AGENTS_PROBLEM_TYPES.draftTooLarge],
    [new DraftTooManyFilesError(200), 422, AGENTS_PROBLEM_TYPES.draftTooManyFiles],
    [new DraftPathNotWritableError('a'), 422, AGENTS_PROBLEM_TYPES.draftPathNotWritable],
    [new DraftPathTakenError('a'), 422, AGENTS_PROBLEM_TYPES.draftPathTaken],
    [new DraftPathConflictError('a'), 422, AGENTS_PROBLEM_TYPES.draftPathConflict],
    [new DraftMoveUnsupportedError(), 422, AGENTS_PROBLEM_TYPES.draftMoveUnsupported],
    [new DraftFileNotFoundError('a'), 404, AGENTS_PROBLEM_TYPES.agentFileNotFound],
    [new DraftNoBaseError(), 409, AGENTS_PROBLEM_TYPES.draftNoBase],
    [new DraftChangedConcurrentlyError(), 409, AGENTS_PROBLEM_TYPES.draftConflict],
    [new DraftBaseMissingError(), 409, AGENTS_PROBLEM_TYPES.draftBaseMissing],
    [new DraftBaseUnreadableError(), 503, AGENTS_PROBLEM_TYPES.agentFilesUnreadable],
  ])('maps %s to %i %s, each refusal with its own reason', (error, status, type) => {
    expect(problemOf(toDraftHttpError(error))).toMatchObject({ status, type });
  });

  it('carries the sizes of a limit refusal', () => {
    expect(problemOf(toDraftHttpError(new DraftFileTooLargeError(5, 3))).extensions).toEqual({
      size: 5,
      limit: 3,
    });
    expect(problemOf(toDraftHttpError(new DraftTooLargeError(9, 7))).extensions).toEqual({
      size: 9,
      limit: 7,
    });
    expect(problemOf(toDraftHttpError(new DraftTooManyFilesError(200))).extensions).toEqual({
      limit: 200,
    });
  });

  it('answers a bad path as a field error on the path', () => {
    const error = toDraftHttpError(new InvalidAgentDraftPathError('Enter a path.'));

    expect(error).toBeInstanceOf(FieldProblemException);
    expect(problemOf(error)).toMatchObject({
      status: 400,
      errors: [{ path: 'path', message: 'Enter a path.' }],
    });
  });

  it('returns anything else as it is', () => {
    const error = new TypeError('bug');

    expect(toDraftHttpError(error)).toBe(error);
  });
});
