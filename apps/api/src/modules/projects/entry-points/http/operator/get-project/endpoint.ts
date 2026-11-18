import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { toProjectResponse } from '../../shared/project-response.js';
import { PROJECTS_PROBLEM_TYPES, projectNotFound } from '../../shared/problems.js';
import { toRepositorySummary } from '../../shared/repository-response.js';
import {
  GetProjectHandler,
  type GetProjectResult,
} from '../../../../application/features/get-project/handler.js';
import { ProjectDetailResponseDto } from './schema.js';
import { ProjectNotFoundError } from '../../../../domain/errors/project-errors.js';

/** `GET /api/projects/:id`, behind the global session guard. */
@ApiTags('projects')
@Controller('projects')
export class GetProjectEndpoint {
  constructor(private readonly handler: GetProjectHandler) {}

  @Get(':id')
  @ApiOperation({ operationId: 'getProject' })
  @ZodResponse({ status: 200, type: ProjectDetailResponseDto })
  @ApiProblemResponses({ 404: `Unknown project (${PROJECTS_PROBLEM_TYPES.projectNotFound})` })
  async get(@Param('id') id: string) {
    let detail: GetProjectResult;
    try {
      detail = await this.handler.execute({ projectId: id });
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw projectNotFound();
      throw error;
    }
    return {
      ...toProjectResponse(detail.project),
      repository: detail.repository ? toRepositorySummary(detail.repository) : null,
    };
  }
}
