import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { ReadAgentDraftFileHandler } from '../../../../application/features/read-agent-draft-file/handler.js';
import {
  AGENTS_PROBLEM_TYPES,
  agentCommitNotFound,
  agentFileNotFound,
  agentFilesUnreadable,
} from '../../shared/problems.js';
import { AgentDraftFileResponseDto, GetAgentDraftFileQueryDto } from './schema.js';

/** `GET /api/agents/definitions-repository/draft/files/content`, behind the global session guard: an operator route only. */
@ApiTags('agents')
@Controller('agents')
export class GetAgentDraftFileEndpoint {
  constructor(private readonly handler: ReadAgentDraftFileHandler) {}

  @Get('definitions-repository/draft/files/content')
  @ApiOperation({
    operationId: 'getAgentDraftFile',
    description:
      'One file as the Draft sees it: its own content when the Draft adds or modifies the ' +
      'file, and the content at the Draft base commit (the last fetched commit while the Draft ' +
      'is empty) otherwise. The answer is the same union as the Repository file route: text, or ' +
      'only the kind and size when the content is binary (a NUL byte, or not valid UTF-8) or ' +
      'over the 1 MiB limit; `commit` is the base commit. A file the Draft deletes is 404. The ' +
      'content is plain text to display, never to render, run or follow.',
  })
  @ZodResponse({ status: 200, type: AgentDraftFileResponseDto })
  @ApiProblemResponses({
    400: 'Invalid path',
    404:
      `No regular file at the path as the Draft sees it (${AGENTS_PROBLEM_TYPES.agentFileNotFound}) ` +
      `or the Clone does not hold the base commit (${AGENTS_PROBLEM_TYPES.agentCommitNotFound})`,
    503: `The Clone cannot be read now (${AGENTS_PROBLEM_TYPES.agentFilesUnreadable})`,
  })
  async get(@Query() query: GetAgentDraftFileQueryDto) {
    const result = await this.handler.execute({ path: query.path });
    switch (result.status) {
      case 'not_found':
        throw agentFileNotFound();
      case 'commit_missing':
        throw agentCommitNotFound();
      case 'unreadable':
        throw agentFilesUnreadable();
      case 'read':
        return { commit: result.commit, path: result.path, ...result.content };
    }
  }
}
