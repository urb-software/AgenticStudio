import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  runAlreadyFinished,
  runNotFound,
} from '../../shared/problems.js';
import { RunAlreadyFinishedError, RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { CancelRunHandler } from '../../../../application/features/cancel-run/handler.js';
import { CancelRunResponseDto } from './schema.js';

@ApiTags('runs')
@Controller('runs')
export class CancelRunEndpoint {
  constructor(private readonly handler: CancelRunHandler) {}

  @Post(':runId/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'cancelRun' })
  @ZodResponse({ status: 202, type: CancelRunResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run has already finished (${EXECUTIONS_PROBLEM_TYPES.runAlreadyFinished})`,
  })
  async cancel(@Param('runId') runId: string) {
    try {
      return await this.handler.execute({ runId });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunAlreadyFinishedError) throw runAlreadyFinished(error.state);
      throw error;
    }
  }
}
