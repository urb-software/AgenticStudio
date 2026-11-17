import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { EXECUTIONS_PROBLEM_TYPES, runNotFound } from '../../shared/problems.js';
import { RunEventPageDto, toRunEventResponse } from '../../shared/run-event-response.js';
import { REDACTED } from '../../../../domain/value-objects/log-redaction.js';
import { ListRunEventsHandler } from '../../../../application/features/list-run-events/handler.js';
import { ListRunEventsQueryDto } from './schema.js';
import { RunNotFoundError } from '../../../../domain/value-objects/run-errors.js';

/**
 * `GET /api/runs/:runId/events?after=&limit=` (Issue #99), behind the global session guard:
 * one page of the stored log (default 500 events, at most 1000).
 */
@ApiTags('runs')
@Controller('runs')
export class ListRunEventsEndpoint {
  constructor(private readonly handler: ListRunEventsHandler) {}

  @Get(':runId/events')
  @ApiOperation({ operationId: 'listRunEvents' })
  @ZodResponse({ status: 200, type: RunEventPageDto })
  @ApiProblemResponses({
    400: 'Invalid after or limit',
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
  })
  async list(@Param('runId') runId: string, @Query() query: ListRunEventsQueryDto) {
    try {
      const page = await this.handler.execute({
        runId,
        after: query.after,
        limit: query.limit,
      });
      return {
        events: page.events.map((event) =>
          toRunEventResponse({ ...event, redacted: event.text.includes(REDACTED) }),
        ),
        ...(page.next === undefined ? {} : { next: page.next }),
      };
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      throw error;
    }
  }
}
