import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiExtraModels, ApiOperation, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  PROBLEM_JSON,
} from '../../../../../../platform/http/problem-details.js';
import { RequestPreviewBuildHandler } from '../../../../application/features/request-preview-build/handler.js';
import { PreviewSettingsMissingError } from '../../../../domain/errors/preview-operation-errors.js';
import {
  DefinitionsProjectError,
  PreviewBuildRunningError,
  PreviewBusyError,
  PreviewControllerUnavailableError,
  PreviewLimitReachedError,
  PreviewRefusedError,
  PreviewRepositoryNotReadyError,
  PreviewSourceUnavailableError,
  ProjectNotFoundError,
} from '../../../../domain/errors/preview-settings-errors.js';
import {
  PreviewBuildDto,
  PreviewLimitReachedProblemDto,
  PreviewRefusedProblemDto,
  toPreviewBuildResponse,
} from '../../shared/preview-response.js';
import {
  buildRunning,
  definitionsProject,
  controllerUnavailable,
  ENVIRONMENTS_PROBLEM_TYPES,
  previewBusy,
  previewLimitReached,
  previewNotConfigured,
  previewRefused,
  projectNotFound,
  repositoryNotReady,
  sourceUnavailable,
} from '../../shared/problems.js';

function toHttpError(error: unknown): unknown {
  if (error instanceof ProjectNotFoundError) return projectNotFound();
  if (error instanceof DefinitionsProjectError) return definitionsProject();
  if (error instanceof PreviewSettingsMissingError) return previewNotConfigured();
  if (error instanceof PreviewRepositoryNotReadyError) return repositoryNotReady(error.reason);
  if (error instanceof PreviewControllerUnavailableError) return controllerUnavailable();
  if (error instanceof PreviewBuildRunningError) return buildRunning();
  if (error instanceof PreviewBusyError) return previewBusy();
  if (error instanceof PreviewLimitReachedError) return previewLimitReached(error);
  if (error instanceof PreviewRefusedError) return previewRefused(error.refusals);
  if (error instanceof PreviewSourceUnavailableError) return sourceUnavailable();
  return error;
}

/** `POST /api/projects/:id/preview/builds`, behind the global session and mutation Origin guards. */
@ApiTags('environments')
@ApiExtraModels(PreviewRefusedProblemDto, PreviewLimitReachedProblemDto)
@Controller('projects')
export class RequestPreviewBuildEndpoint {
  constructor(private readonly handler: RequestPreviewBuildHandler) {}

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
      `The project is the definitions Repository (${ENVIRONMENTS_PROBLEM_TYPES.definitionsProject}), ` +
      `No Preview settings (${ENVIRONMENTS_PROBLEM_TYPES.previewNotConfigured}), the repository ` +
      `cannot be read now (${ENVIRONMENTS_PROBLEM_TYPES.repositoryNotReady}), the API is not on ` +
      `Linux (${ENVIRONMENTS_PROBLEM_TYPES.unsupportedPlatform}), no environment controller is ` +
      `connected (${ENVIRONMENTS_PROBLEM_TYPES.controllerUnavailable}), a build is already ` +
      `running (${ENVIRONMENTS_PROBLEM_TYPES.buildRunning}), a stop or a reset is running ` +
      `(${ENVIRONMENTS_PROBLEM_TYPES.previewBusy}), or every place of the running limit is ` +
      `taken (${ENVIRONMENTS_PROBLEM_TYPES.previewLimitReached}; \`running\` lists the ` +
      'projects that hold them)',
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
      const { build } = await this.handler.execute({ projectId: id });
      return toPreviewBuildResponse(build);
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
