import { Body, Controller, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodValidationPipe, ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  FieldProblemException,
  zodFieldErrors,
} from '../../../../../../platform/http/problem-details.js';
import {
  EnvironmentFileInfoDto,
  toEnvironmentFileInfoResponse,
} from '../../shared/environment-file-response.js';
import {
  definitionsProjectEnvironmentFile,
  PROJECTS_PROBLEM_TYPES,
  projectNotFound,
} from '../../shared/problems.js';
import {
  InvalidEnvironmentFileContentError,
  InvalidEnvironmentFilePathError,
} from '../../../../domain/errors/environment-file-errors.js';
import { SetEnvironmentFileHandler } from '../../../../application/features/set-environment-file/handler.js';
import { type SetEnvironmentFileRequest, SetEnvironmentFileRequestDto } from './schema.js';
import {
  DefinitionsProjectError,
  ProjectNotFoundError,
} from '../../../../domain/errors/project-errors.js';

const INVALID_REQUEST = 'The request is invalid.';

const UnprocessableBodyPipe = createZodValidationPipe({
  createValidationException: (error) =>
    new FieldProblemException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      INVALID_REQUEST,
      zodFieldErrors(error),
    ),
});

function fieldError(path: string, message: string): FieldProblemException {
  return new FieldProblemException(HttpStatus.UNPROCESSABLE_ENTITY, INVALID_REQUEST, [
    { path, message },
  ]);
}

function toHttpError(error: unknown): unknown {
  if (error instanceof ProjectNotFoundError) return projectNotFound();
  if (error instanceof DefinitionsProjectError) return definitionsProjectEnvironmentFile();
  if (error instanceof InvalidEnvironmentFilePathError) return fieldError('path', error.message);
  if (error instanceof InvalidEnvironmentFileContentError) {
    return fieldError('content', error.message);
  }
  return error;
}

/**
 * `PUT /api/projects/:id/environment-file`, behind the global session and mutation Origin
 * guards. The response never contains the content.
 */
@ApiTags('projects')
@Controller('projects')
export class SetEnvironmentFileEndpoint {
  constructor(private readonly handler: SetEnvironmentFileHandler) {}

  @Put(':id/environment-file')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'setEnvironmentFile',
    description:
      "Sets the project's Environment file, or replaces it: a file of test settings Studio " +
      "writes into each Run's Working copy (owner-only, never committed). The content is " +
      'stored in the secret store and never returned. Runs prepared afterwards get the new ' +
      'file; Runs already claimed keep theirs.',
  })
  @ApiBody({ type: SetEnvironmentFileRequestDto })
  @ZodResponse({ status: 200, type: EnvironmentFileInfoDto })
  @ApiProblemResponses({
    404: `Unknown project (${PROJECTS_PROBLEM_TYPES.projectNotFound})`,
    409: `The project is the definitions Repository (${PROJECTS_PROBLEM_TYPES.definitionsProject})`,
    422:
      'Invalid path (not a safe relative path, inside .git, or tracked in the repository) or ' +
      'content (over 64 KiB, not UTF-8); field errors on path or content say why',
  })
  async set(
    @Param('id') id: string,
    @Body(new UnprocessableBodyPipe(SetEnvironmentFileRequestDto)) body: SetEnvironmentFileRequest,
  ) {
    try {
      return toEnvironmentFileInfoResponse(
        await this.handler.execute({ projectId: id, path: body.path, content: body.content }),
      );
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
