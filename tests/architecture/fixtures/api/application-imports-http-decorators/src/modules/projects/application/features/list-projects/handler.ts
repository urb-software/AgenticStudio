import { Controller, Get, Inject, Injectable, Query } from '@nestjs/common';

@Injectable()
@Controller('projects')
export class ListProjectsHandler {
  constructor(@Inject('LOGGER') private readonly logger: { log(message: string): void }) {}

  @Get()
  async execute(@Query('limit') limit: string): Promise<string[]> {
    this.logger.log(limit);
    return [];
  }
}
