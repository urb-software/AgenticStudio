import { Controller, Delete, HttpCode, HttpStatus, Param, Res } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ServerResponse } from 'node:http';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import {
  noRepository,
  PROJECTS_PROBLEM_TYPES,
  projectNotFound,
  unsupportedPlatform,
} from '../../shared/problems.js';
import {
  type RepositoryResponse,
  RepositoryResponseDto,
  repositoryResponseSchema,
  toRepositoryResponse,
} from '../../shared/repository-response.js';
import { GitUnsupportedPlatformError } from '../../../../application/ports/repository-git.js';
import { DisconnectRepositoryHandler } from '../../../../application/features/disconnect-repository/handler.js';
import { ProjectNotFoundError } from '../../../../domain/errors/project-errors.js';
import { NoRepositoryError } from '../../../../domain/errors/repository-connection-errors.js';

function toHttpError(error: unknown): unknown {
  if (error instanceof ProjectNotFoundError) return projectNotFound();
  if (error instanceof NoRepositoryError) return noRepository();
  if (error instanceof GitUnsupportedPlatformError) return unsupportedPlatform('disconnect');
  return error;
}

/**
 * `DELETE /api/projects/:id/repository`, behind the global session and mutation Origin guards;
 * the web confirm dialog authorizes this destructive Git operation (security.md §4).
 */
@ApiTags('projects')
@Controller('projects')
export class DisconnectRepositoryEndpoint {
  constructor(private readonly handler: DisconnectRepositoryHandler) {}

  @Delete(':id/repository')
  @HttpCode(HttpStatus.ACCEPTED)
  // Not @ZodResponse: it would parse the empty body of the 204 too, so the 202 is documented
  // with @ApiResponse and serialized below by hand.
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
      const result = await this.handler.execute({ projectId: id });
      if (result.disconnected) {
        response.statusCode = HttpStatus.NO_CONTENT;
        return undefined;
      }
      // Closed object: unknown keys are stripped, as the response serializer does elsewhere.
      return repositoryResponseSchema.parse(toRepositoryResponse(result.repository));
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
