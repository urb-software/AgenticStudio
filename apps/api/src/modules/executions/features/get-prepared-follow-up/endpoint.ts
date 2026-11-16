import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../platform/http/problem-details.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  preparedFollowUpNotFound,
  runNotFound,
} from '../../contracts/http/problems.js';
import { RunNotFoundError } from '../../domain/repositories/run-repository.js';
import { GetPreparedFollowUpHandler, PreparedFollowUpNotFoundError } from './handler.js';
import { PreparedFollowUpResponseDto } from './schema.js';

/**
 * `GET /api/runs/:runId/pull-request/failing-checks/prepared` (Issue #145), behind the global
 * session guard: the Follow-up prepared from the Run's failing checks; 404 when there is none (or
 * the Run is unknown). Reading it sends nothing.
 */
@ApiTags('runs')
@Controller('runs')
export class GetPreparedFollowUpEndpoint {
  constructor(private readonly handler: GetPreparedFollowUpHandler) {}

  @Get(':runId/pull-request/failing-checks/prepared')
  @ApiOperation({ operationId: 'getRunPreparedFollowUp' })
  @ZodResponse({ status: 200, type: PreparedFollowUpResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound}) or no prepared Follow-up (${EXECUTIONS_PROBLEM_TYPES.preparedFollowUpNotFound})`,
  })
  async get(@Param('runId') runId: string) {
    try {
      const draft = await this.handler.execute(runId);
      return {
        source: draft.source,
        text: draft.text,
        checks: draft.items.map(({ name, url, logAvailable, section }) => ({
          name,
          url,
          logAvailable,
          section,
        })),
      };
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof PreparedFollowUpNotFoundError) throw preparedFollowUpNotFound();
      throw error;
    }
  }
}
