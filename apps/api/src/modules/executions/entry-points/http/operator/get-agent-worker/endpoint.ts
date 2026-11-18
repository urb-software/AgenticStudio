import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { AgentWorkerResponseDto } from '../../shared/agent-worker-response.js';
import { GetAgentWorkerHandler } from '../../../../application/features/get-agent-worker/handler.js';

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
