import { Controller, Get } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { HealthResponseDto } from './health.schema.js';

/**
 * Unauthenticated liveness probe. Must stay non-sensitive: no versions,
 * hostnames, configuration or dependency details.
 */
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ operationId: 'getHealth' })
  @ZodResponse({ status: 200, type: HealthResponseDto })
  check() {
    return { status: 'ok' as const };
  }
}
