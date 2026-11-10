import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  status: 'ok';
}

/**
 * Unauthenticated liveness probe. Must stay non-sensitive: no versions,
 * hostnames, configuration or dependency details.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return { status: 'ok' };
  }
}
