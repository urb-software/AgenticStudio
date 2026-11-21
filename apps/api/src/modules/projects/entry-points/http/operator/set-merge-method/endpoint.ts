import { Body, Controller, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { ProjectResponseDto, toProjectResponse } from '../../shared/project-response.js';
import { PROJECTS_PROBLEM_TYPES, projectNotFound } from '../../shared/problems.js';
import { SetMergeMethodHandler } from '../../../../application/features/set-merge-method/handler.js';
import { ProjectNotFoundError } from '../../../../domain/errors/project-errors.js';
import { SetMergeMethodRequestDto } from './schema.js';

/** `PUT /api/projects/:id/merge-method`, behind the global session and mutation Origin guards. */
@ApiTags('projects')
@Controller('projects')
export class SetMergeMethodEndpoint {
  constructor(private readonly handler: SetMergeMethodHandler) {}

  @Put(':id/merge-method')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'setMergeMethod',
    description:
      "Sets how the project's Runs are merged: `squash` (the default) or `merge_commit`. " +
      'It applies to merges approved afterwards; a Merge approval already stored keeps the ' +
      'method it recorded.',
  })
  @ZodResponse({ status: 200, type: ProjectResponseDto })
  @ApiProblemResponses({ 404: `Unknown project (${PROJECTS_PROBLEM_TYPES.projectNotFound})` })
  async set(@Param('id') id: string, @Body() body: SetMergeMethodRequestDto) {
    try {
      return toProjectResponse(
        await this.handler.execute({ projectId: id, mergeMethod: body.mergeMethod }),
      );
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw projectNotFound();
      throw error;
    }
  }
}
