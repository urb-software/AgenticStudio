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
  ProjectNotFoundError,
  RemoteAlreadyConnectedError,
  RepositoryAlreadyConnectedError,
} from '../../domain/repositories/project-repository.js';
import { InvalidIntegrationBranchError } from '../../domain/value-objects/integration-branch.js';
import { InvalidRepositoryUrlError } from '../../domain/value-objects/repository-url.js';
import { GitUnsupportedPlatformError } from '../../ports/repository-git.js';
import { ConnectRepositoryHandler } from './handler.js';
import { type ConnectRepositoryRequest, ConnectRepositoryRequestDto } from './schema.js';

const INVALID_REQUEST = 'The request is invalid.';

/**
 * Validates the body with the request schema and answers 422 (not the app-wide 400): the
 * contract of this endpoint (Issue #60). The parameter is typed with the plain request type,
 * so the global pipe leaves it to this one; `@ApiBody` documents the schema.
 */
const UnprocessableBodyPipe = createZodValidationPipe({
  createValidationException: (error) =>
    new FieldProblemException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      INVALID_REQUEST,
      zodFieldErrors(error),
    ),
});

function fieldError(path: string, message: string): FieldProblemException {
  return new FieldProblemException(HttpStatus.UNPROCESSABLE_ENTITY, INVALID_REQUEST, [
    { path, message },
  ]);
}

/** Maps the handler's typed errors to problem+json; anything else stays a generic 500. */
function toHttpError(error: unknown): unknown {
  if (error instanceof ProjectNotFoundError) return projectNotFound();
  if (error instanceof InvalidRepositoryUrlError) return fieldError('url', error.message);
  if (error instanceof InvalidIntegrationBranchError) {
    return fieldError('integrationBranch', error.message);
  }
  if (error instanceof GitUnsupportedPlatformError) return unsupportedPlatform('connect');
  if (error instanceof RepositoryAlreadyConnectedError) {
    return new ProblemException(HttpStatus.CONFLICT, {
      type: PROJECTS_PROBLEM_TYPES.repositoryAlreadyConnected,
      title: 'Repository already connected',
      detail: 'This project already has a repository.',
    });
  }
  if (error instanceof RemoteAlreadyConnectedError) {
    // Only the operator can read it, so naming the other project is fine (clarification 6).
    return new ProblemException(HttpStatus.CONFLICT, {
      type: PROJECTS_PROBLEM_TYPES.remoteAlreadyConnected,
      title: 'Remote already connected',
      detail: error.message,
      errors: [{ path: 'url', message: error.message }],
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

/** `POST /api/projects/:id/repository`, behind the global session and mutation Origin guards. */
@ApiTags('projects')
@Controller('projects')
export class ConnectRepositoryEndpoint {
  constructor(private readonly handler: ConnectRepositoryHandler) {}

  @Post(':id/repository')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    operationId: 'connectRepository',
    description:
      'Connects a repository. A public one over HTTPS is stored as `connecting` and cloned in ' +
      'the background (poll `GET /api/projects/{id}/repository`). A private one over SSH ' +
      '(`git@host:owner/repo.git` or `ssh://`) gets a Deploy key generated for the project and ' +
      'is stored as `awaiting_key` with its `publicKey`: add the key on the Git host, then ' +
      '`POST /api/projects/{id}/repository/verify`. A `failed` repository is replaced by the ' +
      'new attempt (an SSH one keeps its Deploy key).',
  })
  @ApiBody({ type: ConnectRepositoryRequestDto })
  @ZodResponse({ status: 201, type: RepositoryResponseDto })
  @ApiProblemResponses({
    404: `Unknown project (${PROJECTS_PROBLEM_TYPES.projectNotFound})`,
    409:
      `The project already has a repository (${PROJECTS_PROBLEM_TYPES.repositoryAlreadyConnected}), ` +
      `the remote is connected to another project (${PROJECTS_PROBLEM_TYPES.remoteAlreadyConnected}; ` +
      `field error on url), or an earlier clone is still finishing ` +
      `(${PROJECTS_PROBLEM_TYPES.cloneAlreadyRunning})`,
    422: 'Invalid url or integrationBranch (field errors)',
    501: `The API host is not Linux (${PROJECTS_PROBLEM_TYPES.unsupportedPlatform})`,
    503: 'The job queue is unavailable; the attempt is marked failed (generic problem)',
  })
  async connect(
    @Param('id') id: string,
    @Body(new UnprocessableBodyPipe(ConnectRepositoryRequestDto)) body: ConnectRepositoryRequest,
  ) {
    try {
      return toRepositoryResponse(
        await this.handler.execute({
          projectId: id,
          url: body.url,
          integrationBranch: body.integrationBranch,
        }),
      );
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
