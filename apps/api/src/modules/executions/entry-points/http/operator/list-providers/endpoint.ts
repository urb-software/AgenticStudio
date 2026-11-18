import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ProviderListResponseDto } from '../../shared/provider-response.js';
import { ListProvidersHandler } from '../../../../application/features/list-providers/handler.js';

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
