import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { GetPreviewHandler } from '../../../../application/features/get-preview/handler.js';
import { RequestPreviewStopHandler } from '../../../../application/features/request-preview-stop/handler.js';
import {
  DefinitionsProjectError,
  PreviewBuildRunningError,
  PreviewBusyError,
  PreviewControllerUnavailableError,
  PreviewNotRunningError,
  ProjectNotFoundError,
} from '../../../../domain/errors/preview-settings-errors.js';
import { PreviewDto, toPreviewResponse } from '../../shared/preview-response.js';
import {
  buildRunning,
  definitionsProject,
  controllerUnavailable,
  ENVIRONMENTS_PROBLEM_TYPES,
  previewBusy,
  previewNotRunning,
  projectNotFound,
} from '../../shared/problems.js';

function toHttpError(error: unknown): unknown {
  if (error instanceof ProjectNotFoundError) return projectNotFound();
  if (error instanceof DefinitionsProjectError) return definitionsProject();
  if (error instanceof PreviewControllerUnavailableError) return controllerUnavailable();
  if (error instanceof PreviewBuildRunningError) return buildRunning();
  if (error instanceof PreviewBusyError) return previewBusy();
  if (error instanceof PreviewNotRunningError) return previewNotRunning();
  return error;
}

/** `POST /api/projects/:id/preview/stop`, behind the global session and mutation Origin guards. */
@ApiTags('environments')
@Controller('projects')
export class StopPreviewEndpoint {
  constructor(
    private readonly stop: RequestPreviewStopHandler,
    private readonly preview: GetPreviewHandler,
  ) {}

  @Post(':id/preview/stop')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    operationId: 'stopPreview',
    description:
      'Asks the environment controller to stop the running Preview of the project. The Preview ' +
      'is `stopping` until it has; its volumes are kept. The answer is the Preview.',
  })
  @ZodResponse({ status: 202, type: PreviewDto })
  @ApiProblemResponses({
    404: `Unknown project (${ENVIRONMENTS_PROBLEM_TYPES.projectNotFound})`,
    409:
      `The project is the definitions Repository (${ENVIRONMENTS_PROBLEM_TYPES.definitionsProject}), ` +
      `No environment controller is connected (${ENVIRONMENTS_PROBLEM_TYPES.controllerUnavailable}), ` +
      `a build is running (${ENVIRONMENTS_PROBLEM_TYPES.buildRunning}), a stop or a reset is ` +
      `running (${ENVIRONMENTS_PROBLEM_TYPES.previewBusy}) or the Preview is not running ` +
      `(${ENVIRONMENTS_PROBLEM_TYPES.previewNotRunning})`,
  })
  async request(@Param('id') id: string) {
    try {
      await this.stop.execute({ projectId: id });
      return toPreviewResponse(await this.preview.execute({ projectId: id }));
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
