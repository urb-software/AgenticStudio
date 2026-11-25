import { BASE_RULES } from '@agentic-studio/contracts';
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ReadAgentsHandler } from '../../../../application/features/read-agents/handler.js';
import { toAgentsRepository, toAgentSummary } from '../../shared/agent-response.js';
import { AgentListResponseDto } from './schema.js';

/** `GET /api/agents`, behind the global session guard: an operator route only. */
@ApiTags('agents')
@Controller('agents')
export class ListAgentsEndpoint {
  constructor(private readonly handler: ReadAgentsHandler) {}

  @Get()
  @ApiOperation({
    operationId: 'listAgents',
    description:
      'The agents Studio knows: a built-in Default agent per Provider, then the folders of the ' +
      'definitions Repository at its last fetched commit, each with its problems and whether it ' +
      'is usable. Computed on each request. Also the base rules every Run starts with.',
  })
  @ZodResponse({ status: 200, type: AgentListResponseDto })
  async list() {
    const result = await this.handler.execute();
    return {
      commit: result.commit,
      repository: toAgentsRepository(result.repository),
      truncated: result.truncated,
      baseRules: { version: BASE_RULES.version, text: BASE_RULES.text },
      agents: result.agents.map(toAgentSummary),
    };
  }
}
