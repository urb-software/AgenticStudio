import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { Public } from '../auth/public.decorator.js';
import { BullMqJobQueues } from '../queue/bullmq-job-queues.js';
import { HealthResponseDto } from './health.schema.js';

/**
 * Unauthenticated health probe. Must stay non-sensitive: no versions, hostnames,
 * configuration or dependency details. Answers 503 (generic problem+json) when the
 * job queue's Redis is unreachable.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly queues: BullMqJobQueues) {}

  @Get()
  @ApiOperation({ operationId: 'getHealth' })
  @ZodResponse({ status: 200, type: HealthResponseDto })
  async check() {
    if (!(await this.queues.isAvailable())) {
      throw new ServiceUnavailableException();
    }
    return { status: 'ok' as const };
  }
}
