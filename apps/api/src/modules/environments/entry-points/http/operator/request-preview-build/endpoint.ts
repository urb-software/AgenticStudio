import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiExtraModels, ApiOperation, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  PROBLEM_JSON,
} from '../../../../../../platform/http/problem-details.js';
import { RequestPreviewOperationHandler } from '../../../../application/features/request-preview-operation/handler.js';
import { PreviewSettingsMissingError } from '../../../../domain/errors/preview-operation-errors.js';
import {
  PreviewBuildRunningError,
  PreviewControllerUnavailableError,
  PreviewRefusedError,
  PreviewRepositoryNotReadyError,
  PreviewSourceUnavailableError,
  ProjectNotFoundError,
} from '../../../../domain/errors/preview-settings-errors.js';
import {
  PreviewBuildDto,
  PreviewRefusedProblemDto,
  toPreviewBuildResponse,
} from '../../shared/preview-response.js';
import {
  buildRunning,
  controllerUnavailable,
  ENVIRONMENTS_PROBLEM_TYPES,
  previewNotConfigured,
  previewRefused,
  projectNotFound,
  repositoryNotReady,
  sourceUnavailable,
} from '../../shared/problems.js';

function toHttpError(error: unknown): unknown {
  if (error instanceof ProjectNotFoundError) return projectNotFound();
  if (error instanceof PreviewSettingsMissingError) return previewNotConfigured();
  if (error instanceof PreviewRepositoryNotReadyError) return repositoryNotReady(error.reason);
  if (error instanceof PreviewControllerUnavailableError) return controllerUnavailable();
  if (error instanceof PreviewBuildRunningError) return buildRunning();
  if (error instanceof PreviewRefusedError) return previewRefused(error.refusals);
  if (error instanceof PreviewSourceUnavailableError) return sourceUnavailable();
  return error;
}

/** `POST /api/projects/:id/preview/builds`, behind the global session and mutation Origin guards. */
@ApiTags('environments')
@ApiExtraModels(PreviewRefusedProblemDto)
@Controller('projects')
export class RequestPreviewBuildEndpoint {
  constructor(private readonly handler: RequestPreviewOperationHandler) {}

  @Post(':id/preview/builds')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    operationId: 'requestPreviewBuild',
    description:
      "Asks the environment controller to build and start the project's Preview from the " +
      'commit its Clone holds. The Compose file is judged again at that commit first. The ' +
      'answer is the queued build; the Preview and the build log are read from the other routes.',
  })
  @ZodResponse({ status: 202, type: PreviewBuildDto })
  @ApiProblemResponses({
    404: `Unknown project (${ENVIRONMENTS_PROBLEM_TYPES.projectNotFound})`,
    409:
      `No Preview settings (${ENVIRONMENTS_PROBLEM_TYPES.previewNotConfigured}), the repository ` +
      `cannot be read now (${ENVIRONMENTS_PROBLEM_TYPES.repositoryNotReady}), the API is not on ` +
      `Linux (${ENVIRONMENTS_PROBLEM_TYPES.unsupportedPlatform}), no environment controller is ` +
      `connected (${ENVIRONMENTS_PROBLEM_TYPES.controllerUnavailable}), or a build is already ` +
      `running (${ENVIRONMENTS_PROBLEM_TYPES.buildRunning})`,
    502: `The Compose file could not be read (${ENVIRONMENTS_PROBLEM_TYPES.sourceUnavailable})`,
  })
  @ApiResponse({
    status: 422,
    description:
      `The Compose file was refused at this commit (${ENVIRONMENTS_PROBLEM_TYPES.previewRefused}); ` +
      '`refusals` lists every reason with its place',
    content: { [PROBLEM_JSON]: { schema: { $ref: getSchemaPath(PreviewRefusedProblemDto) } } },
  })
  async request(@Param('id') id: string) {
    try {
      const { build } = await this.handler.execute({ projectId: id, kind: 'build' });
      if (build === null) throw new Error('A build request answered without a build.');
      return toPreviewBuildResponse(build);
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
