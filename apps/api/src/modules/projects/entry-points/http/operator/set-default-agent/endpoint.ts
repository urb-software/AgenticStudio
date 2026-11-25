import { Body, Controller, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { ProjectResponseDto, toProjectResponse } from '../../shared/project-response.js';
import {
  definitionsProjectDefaultAgent,
  PROJECTS_PROBLEM_TYPES,
  projectNotFound,
} from '../../shared/problems.js';
import { SetDefaultAgentHandler } from '../../../../application/features/set-default-agent/handler.js';
import {
  DefinitionsProjectError,
  ProjectNotFoundError,
} from '../../../../domain/errors/project-errors.js';
import { SetDefaultAgentRequestDto } from './schema.js';

/** `PUT /api/projects/:id/default-agent`, behind the global session and mutation Origin guards. */
@ApiTags('projects')
@Controller('projects')
export class SetDefaultAgentEndpoint {
  constructor(private readonly handler: SetDefaultAgentHandler) {}

  @Put(':id/default-agent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'setDefaultAgent',
    description:
      'Names the agent a Run of the project offers first, or `null` for none. Only the name ' +
      "is checked: whether the agent is usable is judged when the project's run agents are " +
      'listed, and then the built-in Default agent is preselected instead.',
  })
  @ZodResponse({ status: 200, type: ProjectResponseDto })
  @ApiProblemResponses({
    404: `Unknown project (${PROJECTS_PROBLEM_TYPES.projectNotFound})`,
    409: `The project is the definitions Repository (${PROJECTS_PROBLEM_TYPES.definitionsProject}; refused: default_agent)`,
  })
  async set(@Param('id') id: string, @Body() body: SetDefaultAgentRequestDto) {
    try {
      return toProjectResponse(await this.handler.execute({ projectId: id, agent: body.agent }));
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw projectNotFound();
      if (error instanceof DefinitionsProjectError) throw definitionsProjectDefaultAgent();
      throw error;
    }
  }
}
