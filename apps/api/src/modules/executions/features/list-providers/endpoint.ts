import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ProviderListResponseDto } from '../../contracts/http/provider-response.js';
import { ListProvidersHandler } from './handler.js';

/**
 * `GET /api/providers` (Issue #101), behind the session guard: each provider, available or
 * not with the reason, from the latest agent worker status.
 */
@ApiTags('runs')
@Controller('providers')
export class ListProvidersEndpoint {
  constructor(private readonly handler: ListProvidersHandler) {}

  @Get()
  @ApiOperation({ operationId: 'listProviders' })
  @ZodResponse({ status: 200, type: ProviderListResponseDto })
  list() {
    return this.handler.execute();
  }
}
