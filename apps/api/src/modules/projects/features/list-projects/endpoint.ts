import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { toProjectResponse } from '../../contracts/index.js';
import { ListProjectsHandler } from './handler.js';
import { ProjectListResponseDto } from './schema.js';

/** `GET /api/projects`, behind the global session guard. */
@ApiTags('projects')
@Controller('projects')
export class ListProjectsEndpoint {
  constructor(private readonly handler: ListProjectsHandler) {}

  @Get()
  @ApiOperation({ operationId: 'listProjects' })
  @ZodResponse({ status: 200, type: ProjectListResponseDto })
  async list() {
    const projects = await this.handler.execute();
    return { items: projects.map(toProjectResponse) };
  }
}
