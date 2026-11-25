import { Controller, Delete, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { DiscardAgentDraftHandler } from '../../../../application/features/discard-agent-draft/handler.js';
import { AgentDraftResponseDto, toAgentDraftResponse } from '../../shared/agent-draft-response.js';

/** `DELETE /api/agents/definitions-repository/draft`, behind the global session and mutation Origin guards: an operator route only. */
@ApiTags('agents')
@Controller('agents')
export class DiscardAgentDraftEndpoint {
  constructor(private readonly handler: DiscardAgentDraftHandler) {}

  @Delete('definitions-repository/draft')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'discardAgentDraft',
    description:
      'Discards every change of the Draft and its base commit. The answer is the empty Draft ' +
      'with its raised `version`. It reads nothing from the Repository and changes no agent.',
  })
  @ZodResponse({ status: 200, type: AgentDraftResponseDto })
  async discard() {
    return toAgentDraftResponse(await this.handler.execute());
  }
}
