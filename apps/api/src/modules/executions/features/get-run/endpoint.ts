import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../platform/http/problem-details.js';
import { EXECUTIONS_PROBLEM_TYPES, runNotFound } from '../../contracts/http/problems.js';
import { RunResponseDto, toRunResponse } from '../../contracts/http/run-response.js';
import { RunNotFoundError } from '../../domain/repositories/run-repository.js';
import { GetRunHandler } from './handler.js';

/**
 * `GET /api/runs/:runId` (Issue #96), behind the global session guard: the Run with its
 * conversation and whether it can take a Follow-up now (Issue #141).
 */
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
      const { run, followUp, workerConnected } = await this.handler.execute(runId);
      return toRunResponse(run, followUp, workerConnected);
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      throw error;
    }
  }
}
