import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../platform/http/problem-details.js';
import { EXECUTIONS_PROBLEM_TYPES, runNotFound } from '../../contracts/http/problems.js';
import { RunNotFoundError } from '../../domain/repositories/run-repository.js';
import { ListRunStepsHandler } from './handler.js';
import { RunStepListDto } from './schema.js';

/**
 * `GET /api/runs/:runId/steps` (Issue #99), behind the global session guard: the structured
 * result of each reported Run step (summary and checks), shown at the step's end in the log.
 */
@ApiTags('runs')
@Controller('runs')
export class ListRunStepsEndpoint {
  constructor(private readonly handler: ListRunStepsHandler) {}

  @Get(':runId/steps')
  @ApiOperation({ operationId: 'listRunSteps' })
  @ZodResponse({ status: 200, type: RunStepListDto })
  @ApiProblemResponses({ 404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})` })
  async list(@Param('runId') runId: string) {
    try {
      const steps = await this.handler.execute(runId);
      return {
        steps: steps.map((step) => ({ ...step, reportedAt: step.reportedAt.toISOString() })),
      };
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      throw error;
    }
  }
}
