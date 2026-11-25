import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { ReadAgentsHandler } from '../../../../application/features/read-agents/handler.js';
import { toAgentsRepository, toAgentSummary } from '../../shared/agent-response.js';
import { AGENTS_PROBLEM_TYPES, agentNotFound } from '../../shared/problems.js';
import { AgentDetailResponseDto } from './schema.js';

/** `GET /api/agents/:name`, behind the global session guard: an operator route only. */
@ApiTags('agents')
@Controller('agents')
export class GetAgentEndpoint {
  constructor(private readonly handler: ReadAgentsHandler) {}

  @Get(':name')
  @ApiOperation({
    operationId: 'getAgent',
    description:
      'One agent with its instructions (plain text) and the files of its folder with their ' +
      'sizes, read at the last fetched commit of the definitions Repository. A name that a ' +
      'built-in agent has always answers the built-in one (rows are unique by `source` and `name`).',
  })
  @ZodResponse({ status: 200, type: AgentDetailResponseDto })
  @ApiProblemResponses({ 404: `Unknown agent (${AGENTS_PROBLEM_TYPES.agentNotFound})` })
  async get(@Param('name') name: string) {
    const result = await this.handler.execute({ name });
    const agent = result.agents[0];
    if (!agent) throw agentNotFound();
    return {
      commit: result.commit,
      repository: toAgentsRepository(result.repository),
      agent: { ...toAgentSummary(agent), instructions: agent.instructions, files: agent.files },
    };
  }
}
