import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { GetPreviewBuildEventsHandler } from '../../../../application/features/get-preview-build-events/handler.js';
import { PreviewBuildNotFoundError } from '../../../../domain/errors/preview-operation-errors.js';
import { ProjectNotFoundError } from '../../../../domain/errors/preview-settings-errors.js';
import {
  PreviewBuildEventsDto,
  toPreviewBuildEventsResponse,
} from '../../shared/preview-response.js';
import {
  buildNotFound,
  ENVIRONMENTS_PROBLEM_TYPES,
  projectNotFound,
} from '../../shared/problems.js';
import { GetPreviewBuildEventsQueryDto } from './schema.js';

/** `GET /api/projects/:id/preview/builds/:buildId/events`, behind the global session guard: an operator route only. */
@ApiTags('environments')
@Controller('projects')
export class GetPreviewBuildEventsEndpoint {
  constructor(private readonly handler: GetPreviewBuildEventsHandler) {}

  @Get(':id/preview/builds/:buildId/events')
  @ApiOperation({
    operationId: 'listPreviewBuildEvents',
    description:
      "One page of a build's log, already redacted. Read the next page with `after` set to " +
      '`next`; the log is complete when `final` is true and there is no `next`.',
  })
  @ZodResponse({ status: 200, type: PreviewBuildEventsDto })
  @ApiProblemResponses({
    400: 'Invalid after or limit',
    404:
      `Unknown project (${ENVIRONMENTS_PROBLEM_TYPES.projectNotFound}) or unknown build ` +
      `(${ENVIRONMENTS_PROBLEM_TYPES.buildNotFound})`,
  })
  async list(
    @Param('id') id: string,
    @Param('buildId') buildId: string,
    @Query() query: GetPreviewBuildEventsQueryDto,
  ) {
    try {
      return toPreviewBuildEventsResponse(
        await this.handler.execute({
          projectId: id,
          buildId,
          after: query.after,
          limit: query.limit,
        }),
      );
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw projectNotFound();
      if (error instanceof PreviewBuildNotFoundError) throw buildNotFound();
      throw error;
    }
  }
}
