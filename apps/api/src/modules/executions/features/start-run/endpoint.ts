import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  FieldProblemException,
  zodFieldErrors,
} from '../../../../platform/http/problem-details.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  projectNotFound,
  providerUnavailable,
  repositoryNotReady,
} from '../../contracts/http/problems.js';
import { RunResponseDto, toRunResponse } from '../../contracts/http/run-response.js';
import { RepositoryNotReadyError, RunProjectNotFoundError } from '../../domain/entities/run.js';
import { ProviderUnavailableError } from '../../domain/services/provider-availability.js';
import { StartRunHandler } from './handler.js';
import { startRunRequestSchema, StartRunRequestDto } from './schema.js';

/**
 * `POST /api/projects/:id/runs` (Issue #96), behind the global session and mutation Origin
 * guards. The body is typed `unknown`, so the global pipe leaves it alone and an invalid body
 * becomes a 422 here; the DTO documents it.
 */
@ApiTags('runs')
@Controller('projects')
export class StartRunEndpoint {
  constructor(private readonly handler: StartRunHandler) {}

  @Post(':id/runs')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ operationId: 'startRun' })
  @ApiBody({ type: StartRunRequestDto })
  @ZodResponse({ status: 201, type: RunResponseDto })
  @ApiProblemResponses({
    404: `Unknown project (${EXECUTIONS_PROBLEM_TYPES.projectNotFound})`,
    409:
      `The project's repository is missing or not ready (${EXECUTIONS_PROBLEM_TYPES.repositoryNotReady}), ` +
      'or the provider is switched off on the agent worker or no agent worker is connected ' +
      `(${EXECUTIONS_PROBLEM_TYPES.providerUnavailable})`,
    422: 'Invalid request body (field errors)',
  })
  async start(@Param('id') projectId: string, @Body() body: unknown) {
    const parsed = startRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    try {
      return toRunResponse(await this.handler.execute({ projectId, ...parsed.data }));
    } catch (error) {
      if (error instanceof RunProjectNotFoundError) throw projectNotFound();
      if (error instanceof RepositoryNotReadyError) throw repositoryNotReady(error.message);
      if (error instanceof ProviderUnavailableError) throw providerUnavailable(error.reason);
      throw error;
    }
  }
}
