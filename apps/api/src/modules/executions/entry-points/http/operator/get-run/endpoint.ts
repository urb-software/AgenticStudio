import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { EXECUTIONS_PROBLEM_TYPES, runNotFound } from '../../shared/problems.js';
import { RunResponseDto, toRunResponse, withPreparedFollowUp } from '../../shared/run-response.js';
import { GetRunHandler } from '../../../../application/features/get-run/handler.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';

@ApiTags('runs')
@Controller('runs')
export class GetRunEndpoint {
  constructor(private readonly handler: GetRunHandler) {}

  @Get(':runId')
  @ApiOperation({ operationId: 'getRun' })
  @ZodResponse({ status: 200, type: RunResponseDto })
  @ApiProblemResponses({ 404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})` })
  async get(@Param('runId') runId: string) {
    try {
      const { run, followUp, workerConnected, preparedFollowUp } = await this.handler.execute({
        runId,
      });
      return toRunResponse(withPreparedFollowUp(run, preparedFollowUp), followUp, workerConnected);
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      throw error;
    }
  }
}
