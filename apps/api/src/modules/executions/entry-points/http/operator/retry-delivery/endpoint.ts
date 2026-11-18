import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import {
  deliveryNotRetryable,
  EXECUTIONS_PROBLEM_TYPES,
  runNotFound,
} from '../../shared/problems.js';
import { RunResponseDto, toRunResponse, withPreparedFollowUp } from '../../shared/run-response.js';
import {
  DeliveryNotRetryableError,
  RunNotFoundError,
} from '../../../../domain/errors/run-errors.js';
import { RetryDeliveryHandler } from '../../../../application/features/retry-delivery/handler.js';

@ApiTags('runs')
@Controller('runs')
export class RetryDeliveryEndpoint {
  constructor(private readonly handler: RetryDeliveryHandler) {}

  @Post(':runId/retry-delivery')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'retryRunDelivery' })
  @ZodResponse({ status: 202, type: RunResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run's delivery did not fail (${EXECUTIONS_PROBLEM_TYPES.deliveryNotRetryable})`,
  })
  async retry(@Param('runId') runId: string) {
    try {
      const { run, preparedFollowUp } = await this.handler.execute({ runId });
      return toRunResponse(withPreparedFollowUp(run, preparedFollowUp));
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof DeliveryNotRetryableError) throw deliveryNotRetryable();
      throw error;
    }
  }
}
