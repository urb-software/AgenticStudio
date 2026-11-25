import { HttpStatus } from '@nestjs/common';
import { FieldProblemException } from '../../../../../platform/http/problem-details.js';
import {
  DraftBaseUnreadableError,
  DraftFileNotFoundError,
  DraftMoveUnsupportedError,
  DraftNoBaseError,
  DraftPathConflictError,
  DraftPathNotWritableError,
  DraftPathTakenError,
  DraftTooLargeError,
  DraftTooManyFilesError,
} from '../../../domain/errors/agent-draft-errors.js';
import { DraftFileTooLargeError } from '../../../domain/value-objects/agent-draft-file-size.js';
import { InvalidAgentDraftPathError } from '../../../domain/value-objects/agent-draft-path.js';
import {
  agentFileNotFound,
  agentFilesUnreadable,
  draftFileTooLarge,
  draftMoveUnsupported,
  draftNoBase,
  draftPathConflict,
  draftPathNotWritable,
  draftPathTaken,
  draftTooLarge,
  draftTooManyFiles,
} from './problems.js';

/**
 * The HTTP error for what a change to the Draft refuses; anything else is returned as it is. A bad
 * path is a field error on `field`; `to` and `from` name their own field when a move refuses one.
 */
export function toDraftHttpError(error: unknown, field: string = 'path'): unknown {
  if (error instanceof InvalidAgentDraftPathError) {
    return new FieldProblemException(HttpStatus.BAD_REQUEST, 'The request is invalid.', [
      { path: field, message: error.message },
    ]);
  }
  if (error instanceof DraftFileTooLargeError) return draftFileTooLarge(error.size, error.limit);
  if (error instanceof DraftTooLargeError) return draftTooLarge(error.size, error.limit);
  if (error instanceof DraftTooManyFilesError) return draftTooManyFiles(error.limit);
  if (error instanceof DraftPathNotWritableError) return draftPathNotWritable();
  if (error instanceof DraftPathTakenError) return draftPathTaken();
  if (error instanceof DraftPathConflictError) return draftPathConflict();
  if (error instanceof DraftMoveUnsupportedError) return draftMoveUnsupported(error.reason);
  if (error instanceof DraftFileNotFoundError) return agentFileNotFound();
  if (error instanceof DraftNoBaseError) return draftNoBase();
  if (error instanceof DraftBaseUnreadableError) return agentFilesUnreadable();
  return error;
}
