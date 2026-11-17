import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  RunListResponseDto,
  toRunListItem,
  withPreparedFollowUp,
} from '../../shared/run-response.js';
import { ListRunsHandler } from '../../../../application/features/list-runs/handler.js';

/** `GET /api/runs` (Issue #96): every project's Runs, newest first; behind the session guard. */
@ApiTags('runs')
@Controller('runs')
export class ListRunsEndpoint {
  constructor(private readonly handler: ListRunsHandler) {}

  @Get()
  @ApiOperation({ operationId: 'listRuns' })
  @ZodResponse({ status: 200, type: RunListResponseDto })
  async list() {
    return (await this.handler.execute()).map(({ run, preparedFollowUp }) =>
      toRunListItem(withPreparedFollowUp(run, preparedFollowUp)),
    );
  }
}
