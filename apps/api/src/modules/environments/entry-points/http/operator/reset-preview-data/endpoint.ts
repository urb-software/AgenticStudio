import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { GetPreviewHandler } from '../../../../application/features/get-preview/handler.js';
import { RequestPreviewResetDataHandler } from '../../../../application/features/request-preview-reset-data/handler.js';
import {
  DefinitionsProjectError,
  PreviewBuildRunningError,
  PreviewBusyError,
  PreviewControllerUnavailableError,
  ProjectNotFoundError,
} from '../../../../domain/errors/preview-settings-errors.js';
import { PreviewDto, toPreviewResponse } from '../../shared/preview-response.js';
import {
  buildRunning,
  definitionsProject,
  controllerUnavailable,
  ENVIRONMENTS_PROBLEM_TYPES,
  previewBusy,
  projectNotFound,
} from '../../shared/problems.js';

function toHttpError(error: unknown): unknown {
  if (error instanceof ProjectNotFoundError) return projectNotFound();
  if (error instanceof DefinitionsProjectError) return definitionsProject();
  if (error instanceof PreviewControllerUnavailableError) return controllerUnavailable();
  if (error instanceof PreviewBuildRunningError) return buildRunning();
  if (error instanceof PreviewBusyError) return previewBusy();
  return error;
}

/** `POST /api/projects/:id/preview/reset-data`, behind the global session and mutation Origin guards. */
@ApiTags('environments')
@Controller('projects')
export class ResetPreviewDataEndpoint {
  constructor(
    private readonly reset: RequestPreviewResetDataHandler,
    private readonly preview: GetPreviewHandler,
  ) {}

  @Post(':id/preview/reset-data')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    operationId: 'resetPreviewData',
    description:
      'Removes the volumes of the Preview for good, and everything else the controller keeps of ' +
      'it. A running Preview is rebuilt from the commit it runs. The answer is the Preview.',
  })
  @ZodResponse({ status: 202, type: PreviewDto })
  @ApiProblemResponses({
    404: `Unknown project (${ENVIRONMENTS_PROBLEM_TYPES.projectNotFound})`,
    409:
      `The project is the definitions Repository (${ENVIRONMENTS_PROBLEM_TYPES.definitionsProject}), ` +
      `No environment controller is connected (${ENVIRONMENTS_PROBLEM_TYPES.controllerUnavailable}), ` +
      `a build is running (${ENVIRONMENTS_PROBLEM_TYPES.buildRunning}) or a stop or a reset is ` +
      `running (${ENVIRONMENTS_PROBLEM_TYPES.previewBusy})`,
  })
  async request(@Param('id') id: string) {
    try {
      await this.reset.execute({ projectId: id });
      return toPreviewResponse(await this.preview.execute({ projectId: id }));
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
