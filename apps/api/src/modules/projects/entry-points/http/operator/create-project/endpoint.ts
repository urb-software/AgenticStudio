import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { FieldProblemException } from '../../../../../../platform/http/problem-details.js';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { ProjectResponseDto, toProjectResponse } from '../../shared/project-response.js';
import { definitionsProjectExists, PROJECTS_PROBLEM_TYPES } from '../../shared/problems.js';
import { InvalidProjectNameError } from '../../../../domain/value-objects/project-name.js';
import { CreateProjectHandler } from '../../../../application/features/create-project/handler.js';
import { CreateProjectRequestDto } from './schema.js';
import {
  DefinitionsProjectExistsError,
  ProjectNameTakenError,
} from '../../../../domain/errors/project-errors.js';

@ApiTags('projects')
@Controller('projects')
export class CreateProjectEndpoint {
  constructor(private readonly handler: CreateProjectHandler) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ operationId: 'createProject' })
  @ZodResponse({ status: 201, type: ProjectResponseDto })
  @ApiProblemResponses({
    409: `A definitions Repository exists already (${PROJECTS_PROBLEM_TYPES.definitionsProjectExists}); a taken name is a field error on name`,
  })
  async create(@Body() body: CreateProjectRequestDto) {
    try {
      return toProjectResponse(await this.handler.execute({ name: body.name, kind: body.kind }));
    } catch (error) {
      if (error instanceof DefinitionsProjectExistsError) throw definitionsProjectExists();
      if (error instanceof ProjectNameTakenError) {
        throw new FieldProblemException(HttpStatus.CONFLICT, error.message, [
          { path: 'name', message: error.message },
        ]);
      }
      // The Zod schema applies the same rule first; this keeps a divergence a 400, not a 500.
      if (error instanceof InvalidProjectNameError) {
        throw new FieldProblemException(HttpStatus.BAD_REQUEST, 'The request is invalid.', [
          { path: 'name', message: error.message },
        ]);
      }
      throw error;
    }
  }
}
