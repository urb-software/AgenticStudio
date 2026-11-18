import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import {
  deliveryNotRetryable,
  EXECUTIONS_PROBLEM_TYPES,
  runNotFound,
} from '../../shared/problems.js';
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
  @ApiAcceptedResponse({ description: 'The retry is accepted.' })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run's delivery did not fail (${EXECUTIONS_PROBLEM_TYPES.deliveryNotRetryable})`,
  })
  async retry(@Param('runId') runId: string): Promise<void> {
    try {
      await this.handler.execute({ runId });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof DeliveryNotRetryableError) throw deliveryNotRetryable();
      throw error;
    }
  }
}
