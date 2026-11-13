import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  HandledServerErrorException,
  ProblemException,
} from '../../../../platform/http/problem-details.js';
import {
  JobAlreadyActiveError,
  QueueUnavailableError,
} from '../../../../platform/queue/job-queue.js';
import {
  noRepository,
  PROJECTS_PROBLEM_TYPES,
  projectNotFound,
} from '../../contracts/http/problems.js';
import {
  RepositoryResponseDto,
  toRepositoryResponse,
} from '../../contracts/http/repository-response.js';
import {
  NoRepositoryError,
  NoUsableCloneError,
  ProjectNotFoundError,
  RepositoryBusyError,
} from '../../domain/repositories/project-repository.js';
import { GitUnsupportedPlatformError } from '../../ports/repository-git.js';
import { FetchRepositoryHandler } from './handler.js';

function repositoryBusy(): ProblemException {
  return new ProblemException(HttpStatus.CONFLICT, {
    type: PROJECTS_PROBLEM_TYPES.repositoryBusy,
    title: 'Repository busy',
    detail: 'A connect or fetch of this repository is still running. Try again when it ends.',
  });
}

/** Maps the handler's typed errors to problem+json; anything else stays a generic 500. */
function toHttpError(error: unknown): unknown {
  if (error instanceof ProjectNotFoundError) return projectNotFound();
  if (error instanceof NoRepositoryError) return noRepository();
  if (error instanceof RepositoryBusyError || error instanceof JobAlreadyActiveError) {
    return repositoryBusy();
  }
  if (error instanceof NoUsableCloneError) {
    return new ProblemException(HttpStatus.CONFLICT, {
      type: PROJECTS_PROBLEM_TYPES.noUsableClone,
      title: 'No clone to fetch into',
      detail: 'Studio has no usable clone of this repository. Use Retry to clone it again.',
    });
  }
  if (error instanceof GitUnsupportedPlatformError) {
    return new ProblemException(HttpStatus.NOT_IMPLEMENTED, {
      type: PROJECTS_PROBLEM_TYPES.unsupportedPlatform,
      title: 'Unsupported platform',
      detail:
        'Repository features run on Linux only, and this Studio API is not running on Linux. ' +
        'Run the API in a Linux container or on a Linux host to fetch repositories.',
    });
  }
  // The queue logs the outage itself (once); the response stays a generic 503.
  if (error instanceof QueueUnavailableError) {
    return new HandledServerErrorException(HttpStatus.SERVICE_UNAVAILABLE);
  }
  return error;
}

/** `POST /api/projects/:id/repository/fetch`, behind the global session and Origin guards. */
@ApiTags('projects')
@Controller('projects')
export class FetchRepositoryEndpoint {
  constructor(private readonly handler: FetchRepositoryHandler) {}

  @Post(':id/repository/fetch')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    operationId: 'fetchRepository',
    description:
      'Brings the Clone up to date with the remote in the background: answers at once with ' +
      'the repository in `fetching` (poll `GET /api/projects/{id}/repository`). Allowed when ' +
      'the repository is `ready`, or `failed` with a usable Clone (`hasClone`).',
  })
  @ZodResponse({ status: 202, type: RepositoryResponseDto })
  @ApiProblemResponses({
    404:
      `Unknown project (${PROJECTS_PROBLEM_TYPES.projectNotFound}) or no repository ` +
      `(${PROJECTS_PROBLEM_TYPES.noRepository})`,
    409:
      `A connect or fetch is still running (${PROJECTS_PROBLEM_TYPES.repositoryBusy}), or ` +
      `there is no usable Clone to fetch into; use Retry (${PROJECTS_PROBLEM_TYPES.noUsableClone})`,
    501: `The API host is not Linux (${PROJECTS_PROBLEM_TYPES.unsupportedPlatform})`,
    503: 'The job queue is unavailable; the repository keeps its previous state (generic problem)',
  })
  async fetch(@Param('id') id: string) {
    try {
      return toRepositoryResponse(await this.handler.execute(id));
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
