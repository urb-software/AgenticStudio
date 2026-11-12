import { Controller, Get } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { Public } from '../auth/public.decorator.js';
import { HealthResponseDto } from './health.schema.js';

/**
 * Unauthenticated liveness probe. Must stay non-sensitive: no versions,
 * hostnames, configuration or dependency details.
 */
@Public()
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ operationId: 'getHealth' })
  @ZodResponse({ status: 200, type: HealthResponseDto })
  check() {
    return { status: 'ok' as const };
  }
}
