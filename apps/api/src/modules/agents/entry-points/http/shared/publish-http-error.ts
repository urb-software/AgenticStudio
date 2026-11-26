import { HttpStatus } from '@nestjs/common';
import { FieldProblemException } from '../../../../../platform/http/problem-details.js';
import {
  NothingToPublishError,
  PublishFailedError,
  PublishNotJudgedError,
  PublishNotConfiguredError,
  PublishPathOutsideDefinitionsError,
  PublishProblemsError,
  PublishRunningError,
  RepositoryMovedError,
  WriteRefusedError,
} from '../../../domain/errors/agent-publish-errors.js';
import { InvalidPublishMessageError } from '../../../domain/value-objects/publish-message.js';
import { toDraftHttpError } from './draft-http-error.js';
import {
  agentFilesUnreadable,
  draftNotJudged,
  nothingToPublish,
  publishFailed,
  publishNotConfigured,
  publishPathOutsideDefinitions,
  publishProblems,
  publishRunning,
  repositoryMoved,
  writeRefused,
} from './problems.js';

/**
 * The HTTP error for what a publish refuses; the Draft's own refusals (`DraftChangedConcurrentlyError`
 * and the base errors) go through {@link toDraftHttpError}, anything else is returned as it is. No
 * answer carries text of Git, of the host or of a key.
 */
export function toPublishHttpError(error: unknown): unknown {
  if (error instanceof InvalidPublishMessageError) {
    return new FieldProblemException(HttpStatus.BAD_REQUEST, 'The request is invalid.', [
      { path: 'message', message: error.message },
    ]);
  }
  if (error instanceof PublishNotConfiguredError) return publishNotConfigured();
  if (error instanceof PublishRunningError) return publishRunning();
  if (error instanceof NothingToPublishError) return nothingToPublish();
  if (error instanceof RepositoryMovedError) return repositoryMoved();
  if (error instanceof WriteRefusedError) return writeRefused();
  if (error instanceof PublishPathOutsideDefinitionsError) {
    return publishPathOutsideDefinitions(error.paths);
  }
  if (error instanceof PublishNotJudgedError) return draftNotJudged();
  if (error instanceof PublishProblemsError) {
    return publishProblems(error.problems, error.skillProblems);
  }
  if (error instanceof PublishFailedError) {
    return error.reason === 'failed' ? publishFailed() : agentFilesUnreadable();
  }
  return toDraftHttpError(error);
}
