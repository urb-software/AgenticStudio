import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { ReadAgentsHandler } from '../../../../application/features/read-agents/handler.js';
import {
  AGENTS_PROBLEM_TYPES,
  definitionsProject,
  projectNotFound,
} from '../../shared/problems.js';
import { RunAgentListResponseDto } from './schema.js';

/** `GET /api/projects/:id/run-agents`, behind the global session guard: an operator route only. */
@ApiTags('agents')
@Controller('projects')
export class ListRunAgentsEndpoint {
  constructor(private readonly agents: ReadAgentsHandler) {}

  @Get(':id/run-agents')
  @ApiOperation({
    operationId: 'listRunAgents',
    description:
      'The agents a Run of the project can start with, at the definitions Repository last ' +
      "fetched commit: only usable ones. The project's default agent is preselected when it is " +
      'usable; otherwise the Default agent of Claude Code is, with the reason. Computed on each ' +
      'request.',
  })
  @ZodResponse({ status: 200, type: RunAgentListResponseDto })
  @ApiProblemResponses({
    404: `Unknown project (${AGENTS_PROBLEM_TYPES.projectNotFound})`,
    409: `The project is the definitions Repository (${AGENTS_PROBLEM_TYPES.definitionsProject}; refused: run)`,
  })
  async list(@Param('id') projectId: string) {
    const { forRun } = await this.agents.execute({ projectId });
    if (forRun?.status === 'project_not_found') throw projectNotFound();
    if (forRun?.status === 'definitions_project') throw definitionsProject();
    if (forRun?.status !== 'offered') throw new Error('The agents of a project were not read.');
    return {
      agents: forRun.agents,
      preselected: forRun.preselected,
      preselectedReason: forRun.reason,
    };
  }
}
