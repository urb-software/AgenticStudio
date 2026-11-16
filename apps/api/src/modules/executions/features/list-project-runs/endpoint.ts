import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../platform/http/problem-details.js';
import { EXECUTIONS_PROBLEM_TYPES, projectNotFound } from '../../contracts/http/problems.js';
import { RunListResponseDto, toRunListItem } from '../../contracts/http/run-response.js';
import { RunProjectNotFoundError } from '../../domain/entities/run.js';
import { ListProjectRunsHandler } from './handler.js';

/** `GET /api/projects/:id/runs` (Issue #96): a project's Runs, newest first; session guard. */
@ApiTags('runs')
@Controller('projects')
export class ListProjectRunsEndpoint {
  constructor(private readonly handler: ListProjectRunsHandler) {}

  @Get(':id/runs')
  @ApiOperation({ operationId: 'listProjectRuns' })
  @ZodResponse({ status: 200, type: RunListResponseDto })
  @ApiProblemResponses({ 404: `Unknown project (${EXECUTIONS_PROBLEM_TYPES.projectNotFound})` })
  async list(@Param('id') projectId: string) {
    try {
      return (await this.handler.execute(projectId)).map(toRunListItem);
    } catch (error) {
      if (error instanceof RunProjectNotFoundError) throw projectNotFound();
      throw error;
    }
  }
}
