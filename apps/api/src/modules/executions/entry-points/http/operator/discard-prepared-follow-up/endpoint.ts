import { Controller, Delete, HttpCode, HttpStatus, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { EXECUTIONS_PROBLEM_TYPES, runNotFound } from '../../shared/problems.js';
import { DiscardPreparedFollowUpHandler } from '../../../../application/features/discard-prepared-follow-up/handler.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';

@ApiTags('runs')
@Controller('runs')
export class DiscardPreparedFollowUpEndpoint {
  constructor(private readonly handler: DiscardPreparedFollowUpHandler) {}

  @Delete(':runId/pull-request/failing-checks/prepared')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ operationId: 'discardRunPreparedFollowUp' })
  @ApiProblemResponses({ 404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})` })
  async discard(@Param('runId') runId: string): Promise<void> {
    try {
      await this.handler.execute({ runId });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      throw error;
    }
  }
}
