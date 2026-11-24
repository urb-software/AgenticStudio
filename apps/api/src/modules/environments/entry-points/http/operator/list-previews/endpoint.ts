import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ListPreviewsHandler } from '../../../../application/features/list-previews/handler.js';
import { PreviewsListDto } from '../../shared/preview-response.js';

/** `GET /api/previews`, behind the global session guard: an operator route only. */
@ApiTags('environments')
@Controller('previews')
export class ListPreviewsEndpoint {
  constructor(private readonly handler: ListPreviewsHandler) {}

  @Get()
  @ApiOperation({
    operationId: 'listPreviews',
    description:
      'The most Previews that run at the same time, and the projects that take one of those ' +
      'places: a Preview that runs or a build that is requested or claimed.',
  })
  @ZodResponse({ status: 200, type: PreviewsListDto })
  async list() {
    return this.handler.execute();
  }
}
