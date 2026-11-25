import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { GetAgentDraftHandler } from '../../../../application/features/get-agent-draft/handler.js';
import { AgentDraftResponseDto, toAgentDraftResponse } from '../../shared/agent-draft-response.js';

/** `GET /api/agents/definitions-repository/draft`, behind the global session guard: an operator route only. */
@ApiTags('agents')
@Controller('agents')
export class GetAgentDraftEndpoint {
  constructor(private readonly handler: GetAgentDraftHandler) {}

  @Get('definitions-repository/draft')
  @ApiOperation({
    operationId: 'getAgentDraft',
    description:
      'The Draft of the definitions Repository: the files it adds, modifies or deletes, the ' +
      'commit it is based on and the commit the Repository holds now, a `version` raised on ' +
      'every write, the problems the shared validation finds in each agent folder the Draft ' +
      'touches (with the Draft laid over the base tree), and `movedUpstream`, the Draft paths ' +
      'whose content differs between the base and the current commit. A Draft reaches no agent: ' +
      'the agents, their resolution for a Run and their hand-over read only the Clone. When the ' +
      'Clone cannot be read, `problems` and `movedUpstream` are empty.',
  })
  @ZodResponse({ status: 200, type: AgentDraftResponseDto })
  async get() {
    return toAgentDraftResponse(await this.handler.execute());
  }
}
