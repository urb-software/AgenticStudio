import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  FieldProblemException,
  zodFieldErrors,
} from '../../../../../../platform/http/problem-details.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  projectNotFound,
  providerUnavailable,
  repositoryNotReady,
} from '../../shared/problems.js';
import { RunResponseDto, toRunResponse, withPreparedFollowUp } from '../../shared/run-response.js';
import {
  RepositoryNotReadyError,
  RunProjectNotFoundError,
  ProviderUnavailableError,
  InvalidTaskError,
} from '../../../../domain/errors/run-errors.js';
import { StartRunHandler } from '../../../../application/features/start-run/handler.js';
import { startRunRequestSchema, StartRunRequestDto } from './schema.js';

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
      const { run } = await this.handler.execute({ projectId, ...parsed.data });
      return toRunResponse(withPreparedFollowUp(run, false));
    } catch (error) {
      if (error instanceof RunProjectNotFoundError) throw projectNotFound();
      if (error instanceof RepositoryNotReadyError) throw repositoryNotReady(error.message);
      if (error instanceof ProviderUnavailableError) throw providerUnavailable(error.reason);
      // The schema reports these first; this keeps the Task's own rule the one that decides.
      if (error instanceof InvalidTaskError) {
        throw new FieldProblemException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'The request is invalid.',
          [{ path: 'task', message: error.message }],
        );
      }
      throw error;
    }
  }
}
