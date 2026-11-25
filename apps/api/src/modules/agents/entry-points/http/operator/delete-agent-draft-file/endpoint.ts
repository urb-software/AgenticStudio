import { Controller, Delete, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { DeleteAgentDraftFileHandler } from '../../../../application/features/delete-agent-draft-file/handler.js';
import { AgentDraftResponseDto, toAgentDraftResponse } from '../../shared/agent-draft-response.js';
import { toDraftHttpError } from '../../shared/draft-http-error.js';
import { AGENTS_PROBLEM_TYPES } from '../../shared/problems.js';
import { DeleteAgentDraftFileQueryDto } from './schema.js';

/** `DELETE /api/agents/definitions-repository/draft/files`, behind the global session and mutation Origin guards: an operator route only. */
@ApiTags('agents')
@Controller('agents')
export class DeleteAgentDraftFileEndpoint {
  constructor(private readonly handler: DeleteAgentDraftFileHandler) {}

  @Delete('definitions-repository/draft/files')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'deleteAgentDraftFile',
    description:
      'Drops the Draft change at the path (an added file goes, a modified file reverts to the ' +
      'base, a deleted file comes back), or, where the Draft has no change there, marks the file ' +
      'of the base commit deleted. Dropping the last change empties the Draft. A symbolic link ' +
      'or a submodule at the base cannot be deleted. The answer is the new Draft.',
  })
  @ZodResponse({ status: 200, type: AgentDraftResponseDto })
  @ApiProblemResponses({
    400: 'Invalid path',
    404: `No file at the path in the Draft or at the base commit (${AGENTS_PROBLEM_TYPES.agentFileNotFound})`,
    409: `The Repository has no fetched commit to base the Draft on (${AGENTS_PROBLEM_TYPES.draftNoBase})`,
    422:
      `The path is a link or a submodule (${AGENTS_PROBLEM_TYPES.draftPathNotWritable}) or the ` +
      `Draft would change more than 200 files (${AGENTS_PROBLEM_TYPES.draftTooManyFiles})`,
    503: `The Clone cannot be read now (${AGENTS_PROBLEM_TYPES.agentFilesUnreadable})`,
  })
  async remove(@Query() query: DeleteAgentDraftFileQueryDto) {
    try {
      return toAgentDraftResponse(await this.handler.execute({ path: query.path }));
    } catch (error) {
      throw toDraftHttpError(error);
    }
  }
}
