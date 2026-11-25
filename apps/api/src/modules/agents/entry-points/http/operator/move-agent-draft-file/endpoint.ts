import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { MoveAgentDraftFileHandler } from '../../../../application/features/move-agent-draft-file/handler.js';
import { AgentDraftResponseDto, toAgentDraftResponse } from '../../shared/agent-draft-response.js';
import { toDraftHttpError } from '../../shared/draft-http-error.js';
import { AGENTS_PROBLEM_TYPES } from '../../shared/problems.js';
import { MoveAgentDraftFileRequestDto } from './schema.js';

/** `POST /api/agents/definitions-repository/draft/files/move`, behind the global session and mutation Origin guards: an operator route only. */
@ApiTags('agents')
@Controller('agents')
export class MoveAgentDraftFileEndpoint {
  constructor(private readonly handler: MoveAgentDraftFileHandler) {}

  @Post('definitions-repository/draft/files/move')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'moveAgentDraftFile',
    description:
      'Moves a file inside the Draft: a delete of the old path (or dropping it, when only the ' +
      'Draft holds it) plus an add of the new one, linked by `movedFrom`. Moving onto an existing ' +
      'path is refused unless the Draft deletes that path. A file of the base commit over 1 MiB ' +
      'cannot be moved. The answer is the new Draft.',
  })
  @ZodResponse({ status: 200, type: AgentDraftResponseDto })
  @ApiProblemResponses({
    400: 'Invalid path or body',
    404: `No file at the old path (${AGENTS_PROBLEM_TYPES.agentFileNotFound})`,
    409: `The Repository has no fetched commit to base the Draft on (${AGENTS_PROBLEM_TYPES.draftNoBase})`,
    422:
      `A file is at the new path (${AGENTS_PROBLEM_TYPES.draftPathTaken}), a path is a link or a ` +
      `submodule (${AGENTS_PROBLEM_TYPES.draftPathNotWritable}) or would be a file and a folder ` +
      `(${AGENTS_PROBLEM_TYPES.draftPathConflict}), the file cannot be carried ` +
      `(${AGENTS_PROBLEM_TYPES.draftMoveUnsupported}), or a Draft limit is passed ` +
      `(${AGENTS_PROBLEM_TYPES.draftFileTooLarge}, ${AGENTS_PROBLEM_TYPES.draftTooLarge}, ` +
      `${AGENTS_PROBLEM_TYPES.draftTooManyFiles})`,
    503: `The Clone cannot be read now (${AGENTS_PROBLEM_TYPES.agentFilesUnreadable})`,
  })
  async move(@Body() body: MoveAgentDraftFileRequestDto) {
    try {
      return toAgentDraftResponse(await this.handler.execute({ from: body.from, to: body.to }));
    } catch (error) {
      throw toDraftHttpError(error);
    }
  }
}
