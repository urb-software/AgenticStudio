import { Controller, Get } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { Public } from '../auth/public.decorator.js';
import { HandledServerErrorException } from '../http/handled-server-error.js';
import { QueueHealth } from '../queue/queue-health.js';
import { HealthResponseDto } from './health.schema.js';

/**
 * Unauthenticated health probe. Must stay non-sensitive: no versions, hostnames,
 * configuration or dependency details. Answers 503 (generic problem+json) when the
 * job queue's Redis is unreachable.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly queue: QueueHealth) {}

  @Get()
  @ApiOperation({ operationId: 'getHealth' })
  @ZodResponse({ status: 200, type: HealthResponseDto })
  async check() {
    if (!(await this.queue.isAvailable())) {
      // The queue logs the outage once; a probe every few seconds must not log a stack each.
      throw new HandledServerErrorException();
    }
    return { status: 'ok' as const };
  }
}
