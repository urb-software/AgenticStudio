import { Controller, Delete, HttpCode, HttpStatus, Param, Res } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ServerResponse } from 'node:http';
import { ApiProblemResponses } from '../../../../platform/http/problem-details.js';
import {
  noRepository,
  PROJECTS_PROBLEM_TYPES,
  projectNotFound,
  unsupportedPlatform,
} from '../../contracts/http/problems.js';
import {
  type RepositoryResponse,
  RepositoryResponseDto,
  repositoryResponseSchema,
  toRepositoryResponse,
} from '../../contracts/http/repository-response.js';
import {
  NoRepositoryError,
  ProjectNotFoundError,
} from '../../domain/repositories/project-repository.js';
import { GitUnsupportedPlatformError } from '../../ports/repository-git.js';
import { DisconnectRepositoryHandler } from './handler.js';

/** Maps the handler's typed errors to problem+json; anything else stays a generic 500. */
function toHttpError(error: unknown): unknown {
  if (error instanceof ProjectNotFoundError) return projectNotFound();
  if (error instanceof NoRepositoryError) return noRepository();
  if (error instanceof GitUnsupportedPlatformError) return unsupportedPlatform('disconnect');
  return error;
}

/**
 * `DELETE /api/projects/:id/repository`, behind the global session and mutation Origin guards.
 * The confirm dialog in the web app is the operator's explicit authorization of this
 * destructive Git operation (security.md §4).
 */
@ApiTags('projects')
@Controller('projects')
export class DisconnectRepositoryEndpoint {
  constructor(private readonly handler: DisconnectRepositoryHandler) {}

  @Delete(':id/repository')
  // The default answer; a completed disconnect switches to 204 below.
  @HttpCode(HttpStatus.ACCEPTED)
  // Not @ZodResponse: its serializer parses every return value with the response schema,
  // including the empty body of the 204, so this endpoint documents the 202 with @ApiResponse
  // and serializes it below with the same closed schema by hand.
  @ApiOperation({
    operationId: 'disconnectRepository',
    description:
      'Disconnects the repository: a running connect or fetch is cancelled, then Studio ' +
      'removes its Clone, the Deploy key and the pinned host key (when it has them) and the ' +
      'repository record. The project and the remote repository are untouched. 204 when ' +
      'everything was removed; 202 with the repository in `disconnecting` when some of it ' +
      'could not be removed yet (retried at start-up and by repeating this request). A ' +
      'running operation never blocks it.',
  })
  @ApiNoContentResponse({ description: 'Disconnected: nothing of the repository is left' })
  @ApiResponse({
    status: 202,
    type: RepositoryResponseDto.Output,
    description: 'Cleanup is pending: the repository stays `disconnecting` until it completes',
  })
  @ApiProblemResponses({
    404:
      `Unknown project (${PROJECTS_PROBLEM_TYPES.projectNotFound}) or no repository ` +
      `(${PROJECTS_PROBLEM_TYPES.noRepository})`,
    501: `The API host is not Linux (${PROJECTS_PROBLEM_TYPES.unsupportedPlatform})`,
  })
  async disconnect(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<RepositoryResponse | undefined> {
    try {
      const outcome = await this.handler.execute(id);
      if (outcome.disconnected) {
        response.statusCode = HttpStatus.NO_CONTENT;
        return undefined;
      }
      // Closed object: unknown keys are stripped, as the response serializer does elsewhere.
      return repositoryResponseSchema.parse(toRepositoryResponse(outcome.repository));
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
