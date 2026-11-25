import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { GetDefinitionsRepositoryHandler } from '../../../../application/features/get-definitions-repository/handler.js';
import { DefinitionsRepositoryResponseDto } from './schema.js';

/**
 * `GET /api/agents/definitions-repository`, behind the global session guard: an operator route
 * only.
 */
@ApiTags('agents')
@Controller('agents')
export class GetDefinitionsRepositoryEndpoint {
  constructor(private readonly handler: GetDefinitionsRepositoryHandler) {}

  @Get('definitions-repository')
  @ApiOperation({
    operationId: 'getDefinitionsRepository',
    description:
      'The definitions Repository: its Project id with the state of its Repository connection, ' +
      'the Integration branch and the last fetched commit, or `project: null` when none is ' +
      'connected. The connection steps and Fetch use the projects routes with that id.',
  })
  @ZodResponse({ status: 200, type: DefinitionsRepositoryResponseDto })
  async get() {
    const { project } = await this.handler.execute();
    return {
      project: project
        ? {
            id: project.id,
            repository: project.repository
              ? {
                  ...project.repository,
                  lastFetchedAt: project.repository.lastFetchedAt?.toISOString() ?? null,
                }
              : null,
          }
        : null,
    };
  }
}
