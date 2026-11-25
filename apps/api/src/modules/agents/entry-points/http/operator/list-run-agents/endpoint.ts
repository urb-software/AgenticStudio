import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { PreselectRunAgentHandler } from '../../../../application/features/preselect-run-agent/handler.js';
import { ReadAgentsHandler } from '../../../../application/features/read-agents/handler.js';
import { AGENTS_PROBLEM_TYPES, projectNotFound } from '../../shared/problems.js';
import { RunAgentListResponseDto } from './schema.js';

/** `GET /api/projects/:id/run-agents`, behind the global session guard: an operator route only. */
@ApiTags('agents')
@Controller('projects')
export class ListRunAgentsEndpoint {
  constructor(
    private readonly agents: ReadAgentsHandler,
    private readonly preselect: PreselectRunAgentHandler,
  ) {}

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
  })
  async list(@Param('id') projectId: string) {
    const { agents } = await this.agents.execute();
    const chosen = await this.preselect.execute({
      projectId,
      agents: agents.map(({ name, usable }) => ({ name, usable })),
    });
    if (chosen.status === 'project_not_found') throw projectNotFound();
    return {
      agents: agents.flatMap((agent) =>
        agent.usable && agent.provider !== null && agent.model !== null
          ? [
              {
                name: agent.name,
                description: agent.description,
                provider: agent.provider,
                model: agent.model,
                source: agent.source,
              },
            ]
          : [],
      ),
      preselected: chosen.agent,
      preselectedReason: chosen.reason,
    };
  }
}
