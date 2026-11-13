import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../platform/http/problem-details.js';
import { toProjectResponse } from '../../contracts/http/project-response.js';
import { PROJECTS_PROBLEM_TYPES, projectNotFound } from '../../contracts/http/problems.js';
import { toRepositorySummary } from '../../contracts/http/repository-response.js';
import { GetProjectHandler } from './handler.js';
import { ProjectDetailResponseDto } from './schema.js';

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
    const detail = await this.handler.execute(id);
    if (!detail) throw projectNotFound();
    return {
      ...toProjectResponse(detail.project),
      repository: detail.repository ? toRepositorySummary(detail.repository) : null,
    };
  }
}
