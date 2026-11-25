import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { RevertAgentDraftFileHandler } from '../../../../application/features/revert-agent-draft-file/handler.js';
import { AgentDraftResponseDto, toAgentDraftResponse } from '../../shared/agent-draft-response.js';
import { toDraftHttpError } from '../../shared/draft-http-error.js';
import { AGENTS_PROBLEM_TYPES } from '../../shared/problems.js';
import { RevertAgentDraftFileRequestDto } from './schema.js';

/** `POST /api/agents/definitions-repository/draft/files/revert`, behind the global session and mutation Origin guards: an operator route only. */
@ApiTags('agents')
@Controller('agents')
export class RevertAgentDraftFileEndpoint {
  constructor(private readonly handler: RevertAgentDraftFileHandler) {}

  @Post('definitions-repository/draft/files/revert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'revertAgentDraftFile',
    description:
      'Drops the Draft change at the path, so the file is as the base commit has it: an added ' +
      'file goes, a modified file reverts, a deleted file comes back. For a moved file the new ' +
      'path is removed and the original is restored. Dropping the last change empties the Draft. ' +
      'Nothing is read from the Repository. The answer is the new Draft.',
  })
  @ZodResponse({ status: 200, type: AgentDraftResponseDto })
  @ApiProblemResponses({
    400: 'Invalid path or body',
    404: `The Draft does not change the path (${AGENTS_PROBLEM_TYPES.agentFileNotFound})`,
    409: `Other writes kept changing the Draft (${AGENTS_PROBLEM_TYPES.draftConflict})`,
  })
  async revert(@Body() body: RevertAgentDraftFileRequestDto) {
    try {
      return toAgentDraftResponse(await this.handler.execute({ path: body.path }));
    } catch (error) {
      throw toDraftHttpError(error);
    }
  }
}
