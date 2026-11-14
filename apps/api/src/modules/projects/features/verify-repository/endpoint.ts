import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodValidationPipe, ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  FieldProblemException,
  ProblemException,
  zodFieldErrors,
} from '../../../../platform/http/problem-details.js';
import {
  JobAlreadyActiveError,
  QueueUnavailableError,
} from '../../../../platform/queue/job-queue.js';
import {
  noRepository,
  PROJECTS_PROBLEM_TYPES,
  projectNotFound,
  queueUnavailable,
  unsupportedPlatform,
} from '../../contracts/http/problems.js';
import {
  RepositoryResponseDto,
  toRepositoryResponse,
} from '../../contracts/http/repository-response.js';
import {
  NoRepositoryError,
  ProjectNotFoundError,
  RepositoryNotVerifiableError,
} from '../../domain/repositories/project-repository.js';
import { GitUnsupportedPlatformError } from '../../ports/repository-git.js';
import { HostKeyFingerprintMismatchError, VerifyRepositoryHandler } from './handler.js';
import { type VerifyRepositoryRequest, VerifyRepositoryRequestDto } from './schema.js';

const INVALID_REQUEST = 'The request is invalid.';

/** Validates the body and answers 422 with field errors, like connect (Issue #60). */
const UnprocessableBodyPipe = createZodValidationPipe({
  createValidationException: (error) =>
    new FieldProblemException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      INVALID_REQUEST,
      zodFieldErrors(error),
    ),
});

/** Maps the handler's typed errors to problem+json; anything else stays a generic 500. */
function toHttpError(error: unknown): unknown {
  if (error instanceof ProjectNotFoundError) return projectNotFound();
  if (error instanceof NoRepositoryError) return noRepository();
  if (error instanceof GitUnsupportedPlatformError) return unsupportedPlatform('connect');
  if (error instanceof HostKeyFingerprintMismatchError) {
    return new FieldProblemException(HttpStatus.UNPROCESSABLE_ENTITY, INVALID_REQUEST, [
      { path: 'acceptHostKeyFingerprint', message: error.message },
    ]);
  }
  if (error instanceof RepositoryNotVerifiableError) {
    return new ProblemException(HttpStatus.CONFLICT, {
      type: PROJECTS_PROBLEM_TYPES.repositoryNotVerifiable,
      title: 'Nothing to verify',
      detail: error.message,
    });
  }
  if (error instanceof JobAlreadyActiveError) {
    return new ProblemException(HttpStatus.CONFLICT, {
      type: PROJECTS_PROBLEM_TYPES.cloneAlreadyRunning,
      title: 'Clone already running',
      detail: 'An earlier clone of this project is still finishing. Try again in a moment.',
    });
  }
  if (error instanceof QueueUnavailableError) return queueUnavailable();
  return error;
}

/** `POST /api/projects/:id/repository/verify`, behind the global session and Origin guards. */
@ApiTags('projects')
@Controller('projects')
export class VerifyRepositoryEndpoint {
  constructor(private readonly handler: VerifyRepositoryHandler) {}

  @Post(':id/repository/verify')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    operationId: 'verifyRepository',
    description:
      '"Verify and clone" for an SSH repository (`awaiting_key`, `awaiting_host_key`, or ' +
      '`failed` without a Clone: Retry, with the same Deploy key). A Git host listed in the ' +
      "server's trusted host keys, or whose key is pinned for this repository, is cloned at " +
      'once: the answer is the repository in `connecting` (poll ' +
      '`GET /api/projects/{id}/repository`). For any other host, Studio first retrieves its ' +
      'host key: the answer is the repository in `awaiting_host_key` with `hostKeyFingerprint` ' +
      '(or in `failed` when the host cannot be reached), and the operator confirms by ' +
      'verifying again with `acceptHostKeyFingerprint`, which pins the key and starts the clone.',
  })
  @ApiBody({ type: VerifyRepositoryRequestDto })
  @ZodResponse({ status: 202, type: RepositoryResponseDto })
  @ApiProblemResponses({
    404:
      `Unknown project (${PROJECTS_PROBLEM_TYPES.projectNotFound}) or no repository ` +
      `(${PROJECTS_PROBLEM_TYPES.noRepository})`,
    409:
      'The repository is not waiting to be verified, or no host key awaits confirmation ' +
      `(${PROJECTS_PROBLEM_TYPES.repositoryNotVerifiable}), or an earlier clone is still ` +
      `finishing (${PROJECTS_PROBLEM_TYPES.cloneAlreadyRunning})`,
    422: 'Invalid body, or acceptHostKeyFingerprint does not match (field errors)',
    501: `The API host is not Linux (${PROJECTS_PROBLEM_TYPES.unsupportedPlatform})`,
    503: 'The job queue is unavailable; the attempt is marked failed (generic problem)',
  })
  async verify(
    @Param('id') id: string,
    @Body(new UnprocessableBodyPipe(VerifyRepositoryRequestDto)) body: VerifyRepositoryRequest,
  ) {
    try {
      return toRepositoryResponse(
        await this.handler.execute({
          projectId: id,
          acceptHostKeyFingerprint: body.acceptHostKeyFingerprint,
        }),
      );
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
