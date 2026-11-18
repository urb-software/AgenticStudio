import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { GetRunsSummaryHandler } from '../../../../application/features/get-runs-summary/handler.js';
import { RunsSummaryResponseDto } from './schema.js';

/** Registered before `GET /api/runs/:runId`, which would take the path. */
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
