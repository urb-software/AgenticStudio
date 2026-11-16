import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { AgentWorkerResponseDto } from '../../contracts/http/agent-worker-response.js';
import { GetAgentWorkerHandler } from './handler.js';

/**
 * `GET /api/agent-worker` (Issue #143), behind the session guard: whether an agent worker is
 * connected and the disk figures it reported, for the Executions page.
 */
@ApiTags('runs')
@Controller('agent-worker')
export class GetAgentWorkerEndpoint {
  constructor(private readonly handler: GetAgentWorkerHandler) {}

  @Get()
  @ApiOperation({ operationId: 'getAgentWorker' })
  @ZodResponse({ status: 200, type: AgentWorkerResponseDto })
  get() {
    return this.handler.execute();
  }
}
