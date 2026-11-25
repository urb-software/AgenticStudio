import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { ReadAgentFileHandler } from '../../../../application/features/read-agent-file/handler.js';
import {
  AGENTS_PROBLEM_TYPES,
  agentCommitNotFound,
  agentFilesUnreadable,
  agentFileNotFound,
} from '../../shared/problems.js';
import { AgentFileResponseDto, GetAgentFileQueryDto } from './schema.js';

/** `GET /api/agents/definitions-repository/files/content`, behind the global session guard: an operator route only. */
@ApiTags('agents')
@Controller('agents')
export class GetAgentFileEndpoint {
  constructor(private readonly handler: ReadAgentFileHandler) {}

  @Get('definitions-repository/files/content')
  @ApiOperation({
    operationId: 'getAgentFile',
    description:
      'One file of the definitions Repository at a commit (the last fetched one by default): ' +
      'its text, or only its kind and size when it is binary (a NUL byte, or not valid UTF-8) or ' +
      'over the 1 MiB file limit. Read from Git, never from a working tree. A symbolic link, a ' +
      'submodule or a folder is not a file and is 404. The content is plain text to display, ' +
      'never to render, run or follow.',
  })
  @ZodResponse({ status: 200, type: AgentFileResponseDto })
  @ApiProblemResponses({
    400: 'Invalid path or commit id',
    404:
      `No regular file at the path (${AGENTS_PROBLEM_TYPES.agentFileNotFound}) or the Clone ` +
      `does not hold the commit (${AGENTS_PROBLEM_TYPES.agentCommitNotFound})`,
    503: `The Clone cannot be read now (${AGENTS_PROBLEM_TYPES.agentFilesUnreadable})`,
  })
  async get(@Query() query: GetAgentFileQueryDto) {
    const result = await this.handler.execute({ path: query.path, commit: query.commit });
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
