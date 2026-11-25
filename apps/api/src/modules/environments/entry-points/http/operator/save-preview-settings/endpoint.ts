import { Body, Controller, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiExtraModels, ApiOperation, ApiResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  FieldProblemException,
  PROBLEM_JSON,
} from '../../../../../../platform/http/problem-details.js';
import { SavePreviewSettingsHandler } from '../../../../application/features/save-preview-settings/handler.js';
import {
  DefinitionsProjectError,
  PreviewRefusedError,
  PreviewRepositoryNotReadyError,
  PreviewSourceUnavailableError,
  ProjectNotFoundError,
} from '../../../../domain/errors/preview-settings-errors.js';
import { InvalidPreviewPortError } from '../../../../domain/value-objects/preview-port.js';
import { InvalidPreviewServiceError } from '../../../../domain/value-objects/preview-service.js';
import {
  PreviewRefusedProblemDto,
  SavePreviewSettingsResponseDto,
  toPreviewResponse,
} from '../../shared/preview-response.js';
import {
  definitionsProject,
  ENVIRONMENTS_PROBLEM_TYPES,
  previewRefused,
  projectNotFound,
  repositoryNotReady,
  sourceUnavailable,
} from '../../shared/problems.js';
import { SavePreviewSettingsRequestDto } from './schema.js';

const INVALID_REQUEST = 'The request is invalid.';

function fieldError(path: string, message: string): FieldProblemException {
  return new FieldProblemException(HttpStatus.BAD_REQUEST, INVALID_REQUEST, [{ path, message }]);
}

function toHttpError(error: unknown): unknown {
  if (error instanceof ProjectNotFoundError) return projectNotFound();
  if (error instanceof DefinitionsProjectError) return definitionsProject();
  if (error instanceof PreviewRepositoryNotReadyError) return repositoryNotReady(error.reason);
  if (error instanceof PreviewRefusedError) return previewRefused(error.refusals);
  if (error instanceof PreviewSourceUnavailableError) return sourceUnavailable();
  if (error instanceof InvalidPreviewServiceError) return fieldError('service', error.message);
  if (error instanceof InvalidPreviewPortError) return fieldError('port', error.message);
  return error;
}

/**
 * `PUT /api/projects/:id/preview/settings`, behind the global session and mutation Origin guards:
 * an operator route only. The Compose file is read from the Integration branch and judged first.
 */
@ApiTags('environments')
@ApiExtraModels(PreviewRefusedProblemDto)
@Controller('projects')
export class SavePreviewSettingsEndpoint {
  constructor(private readonly handler: SavePreviewSettingsHandler) {}

  @Put(':id/preview/settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'savePreviewSettings',
    description:
      "Sets the project's Preview settings, or replaces them. Studio reads the Compose file from " +
      'the Integration branch at the commit its Clone holds, judges it, and saves only when it ' +
      'is accepted. Published ports in the file are removed when the Preview starts; ' +
      '`removedPorts` lists them.',
  })
  @ZodResponse({ status: 200, type: SavePreviewSettingsResponseDto })
  @ApiProblemResponses({
    404: `Unknown project (${ENVIRONMENTS_PROBLEM_TYPES.projectNotFound})`,
    409:
      `The project is the definitions Repository (${ENVIRONMENTS_PROBLEM_TYPES.definitionsProject}), ` +
      `The repository cannot be read now (${ENVIRONMENTS_PROBLEM_TYPES.repositoryNotReady}), ` +
      `or the API is not on Linux (${ENVIRONMENTS_PROBLEM_TYPES.unsupportedPlatform})`,
    502: `The Compose file could not be read (${ENVIRONMENTS_PROBLEM_TYPES.sourceUnavailable})`,
  })
  @ApiResponse({
    status: 422,
    description:
      `The file or the choice was refused (${ENVIRONMENTS_PROBLEM_TYPES.previewRefused}); ` +
      '`refusals` lists every reason with its place',
    content: { [PROBLEM_JSON]: { schema: { $ref: getSchemaPath(PreviewRefusedProblemDto) } } },
  })
  async save(@Param('id') id: string, @Body() body: SavePreviewSettingsRequestDto) {
    try {
      const { removedPorts, ...view } = await this.handler.execute({
        projectId: id,
        composeFile: body.composeFile,
        service: body.service,
        port: body.port,
      });
      return { ...toPreviewResponse(view), ...(removedPorts.length > 0 ? { removedPorts } : {}) };
    } catch (error) {
      throw toHttpError(error);
    }
  }
}
