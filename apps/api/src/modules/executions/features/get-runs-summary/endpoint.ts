import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { GetRunsSummaryHandler } from './handler.js';
import { RunsSummaryResponseDto } from './schema.js';

/**
 * `GET /api/runs/summary` (Issue #115), behind the global session guard: the counts the top
 * bar's run indicator shows. Registered before `GET /api/runs/:runId`, which would take the path.
 */
@ApiTags('runs')
@Controller('runs')
export class GetRunsSummaryEndpoint {
  constructor(private readonly handler: GetRunsSummaryHandler) {}

  @Get('summary')
  @ApiOperation({ operationId: 'getRunsSummary' })
  @ZodResponse({ status: 200, type: RunsSummaryResponseDto })
  summary() {
    return this.handler.execute();
  }
}
