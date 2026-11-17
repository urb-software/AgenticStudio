import { Controller, Get, Inject, Injectable, Query } from '@nestjs/common';

export type ListProjectsInput = string;
export type ListProjectsResult = string[];

@Injectable()
@Controller('projects')
export class ListProjectsHandler {
  constructor(@Inject('LOGGER') private readonly logger: { log(message: string): void }) {}

  @Get()
  async execute(@Query('limit') limit: ListProjectsInput): Promise<ListProjectsResult> {
    this.logger.log(limit);
    return [];
  }
}
