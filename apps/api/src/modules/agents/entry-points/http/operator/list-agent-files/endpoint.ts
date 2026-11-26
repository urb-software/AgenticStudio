import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ListAgentFilesHandler } from '../../../../application/features/list-agent-files/handler.js';
import { toAgentsRepository } from '../../shared/agent-response.js';
import { isOpenable } from '../../shared/agent-file-path.js';
import { AgentFilesResponseDto } from './schema.js';

/** `GET /api/agents/definitions-repository/files`, behind the global session guard: an operator route only. */
@ApiTags('agents')
@Controller('agents')
export class ListAgentFilesEndpoint {
  constructor(private readonly handler: ListAgentFilesHandler) {}

  @Get('definitions-repository/files')
  @ApiOperation({
    operationId: 'listAgentFiles',
    description:
      'The whole definitions Repository as a tree at its last fetched commit: path, kind ' +
      '(`file`, `symlink` or `submodule`), size and the agent folder and the skill folder each entry belongs to. ' +
      'At most 2,000 entries; `truncated` says when there are more. Read from Git, never from a ' +
      'working tree; links and submodules are listed and never followed. Judges nothing: the ' +
      'problems of an agent come from the agent list, those of a skill from the skill list.',
  })
  @ZodResponse({ status: 200, type: AgentFilesResponseDto })
  async list() {
    const result = await this.handler.execute();
    return {
      commit: result.commit,
      repository: toAgentsRepository(result.repository),
      truncated: result.truncated,
      entries: result.entries.map((entry) => ({ ...entry, openable: isOpenable(entry) })),
    };
  }
}
