import { Body, Controller, HttpCode, HttpStatus, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { SaveAgentDraftFileHandler } from '../../../../application/features/save-agent-draft-file/handler.js';
import { AgentDraftResponseDto, toAgentDraftResponse } from '../../shared/agent-draft-response.js';
import { toDraftHttpError } from '../../shared/draft-http-error.js';
import { AGENTS_PROBLEM_TYPES } from '../../shared/problems.js';
import { SaveAgentDraftFileRequestDto } from './schema.js';

/** `PUT /api/agents/definitions-repository/draft/files`, behind the global session and mutation Origin guards: an operator route only. */
@ApiTags('agents')
@Controller('agents')
export class SaveAgentDraftFileEndpoint {
  constructor(private readonly handler: SaveAgentDraftFileHandler) {}

  @Put('definitions-repository/draft/files')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'saveAgentDraftFile',
    description:
      'Stores one file in the Draft, from `text` (UTF-8) or `contentBase64`. A file the base ' +
      'commit holds becomes modified, any other path added. The first change sets the base ' +
      'commit to the last fetched one. The last save wins; the answer is the new Draft with its ' +
      'raised `version`. A file with a forbidden key is saved and flagged in `problems`. At most ' +
      '1 MiB per file, 10 MiB for the Draft and 200 changed files, each refusal a 422 of its ' +
      'own. A symbolic link or a submodule at the base cannot be written. A Draft reaches no agent.',
  })
  @ZodResponse({ status: 200, type: AgentDraftResponseDto })
  @ApiProblemResponses({
    400: 'Invalid path or body',
    409:
      `The Repository has no fetched commit to base the Draft on (${AGENTS_PROBLEM_TYPES.draftNoBase}), ` +
      `the commit the Draft began from is gone (${AGENTS_PROBLEM_TYPES.draftBaseMissing}) or other writes ` +
      `kept changing the Draft (${AGENTS_PROBLEM_TYPES.draftConflict})`,
    413: 'The request body is over the size the route accepts',
    422:
      `The file is over 1 MiB (${AGENTS_PROBLEM_TYPES.draftFileTooLarge}), the Draft over 10 MiB ` +
      `(${AGENTS_PROBLEM_TYPES.draftTooLarge}) or over 200 files (${AGENTS_PROBLEM_TYPES.draftTooManyFiles}), ` +
      `the path is a link or a submodule (${AGENTS_PROBLEM_TYPES.draftPathNotWritable}) or would be a ` +
      `file and a folder (${AGENTS_PROBLEM_TYPES.draftPathConflict})`,
    503: `The Clone cannot be read now (${AGENTS_PROBLEM_TYPES.agentFilesUnreadable})`,
  })
  async save(@Body() body: SaveAgentDraftFileRequestDto) {
    const content =
      body.text !== undefined
        ? Buffer.from(body.text, 'utf8')
        : Buffer.from(body.contentBase64 ?? '', 'base64');
    try {
      return toAgentDraftResponse(await this.handler.execute({ path: body.path, content }));
    } catch (error) {
      throw toDraftHttpError(error);
    }
  }
}
