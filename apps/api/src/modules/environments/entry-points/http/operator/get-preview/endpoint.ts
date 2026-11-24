import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { GetPreviewHandler } from '../../../../application/features/get-preview/handler.js';
import { ProjectNotFoundError } from '../../../../domain/errors/preview-settings-errors.js';
import { PreviewDto, toPreviewResponse } from '../../shared/preview-response.js';
import { ENVIRONMENTS_PROBLEM_TYPES, projectNotFound } from '../../shared/problems.js';

/** `GET /api/projects/:id/preview`, behind the global session guard: an operator route only. */
@ApiTags('environments')
@Controller('projects')
export class GetPreviewEndpoint {
  constructor(private readonly handler: GetPreviewHandler) {}

  @Get(':id/preview')
  @ApiOperation({
    operationId: 'getPreview',
    description:
      "The project's Preview: its settings or `null`, the hostname it will be served at (or why " +
      'there is none), whether the repository is ready to be read, its state, the build that ' +
      'runs, the latest build and whether an environment controller is connected.',
  })
  @ZodResponse({ status: 200, type: PreviewDto })
  @ApiProblemResponses({ 404: `Unknown project (${ENVIRONMENTS_PROBLEM_TYPES.projectNotFound})` })
  async get(@Param('id') id: string) {
    try {
      return toPreviewResponse(await this.handler.execute({ projectId: id }));
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw projectNotFound();
      throw error;
    }
  }
}
