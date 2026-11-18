import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { noRepository, PROJECTS_PROBLEM_TYPES, projectNotFound } from '../../shared/problems.js';
import { RepositoryResponseDto, toRepositoryResponse } from '../../shared/repository-response.js';
import { GetRepositoryHandler } from '../../../../application/features/get-repository/handler.js';
import { ProjectNotFoundError } from '../../../../domain/value-objects/project-errors.js';

/** `GET /api/projects/:id/repository`, behind the global session guard. */
@ApiTags('projects')
@Controller('projects')
export class GetRepositoryEndpoint {
  constructor(private readonly handler: GetRepositoryHandler) {}

  @Get(':id/repository')
  @ApiOperation({ operationId: 'getRepository' })
  @ZodResponse({ status: 200, type: RepositoryResponseDto })
  @ApiProblemResponses({
    404:
      `Unknown project (${PROJECTS_PROBLEM_TYPES.projectNotFound}) or no repository ` +
      `(${PROJECTS_PROBLEM_TYPES.noRepository})`,
  })
  async get(@Param('id') id: string) {
    let repository;
    try {
      repository = await this.handler.execute({ projectId: id });
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw projectNotFound();
      throw error;
    }
    if (!repository) throw noRepository();
    return toRepositoryResponse(repository);
  }
}
