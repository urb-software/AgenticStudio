import * as common from '@nestjs/common';

export class ListProjectsHandler {
  readonly decorators = common;

  async execute(): Promise<string[]> {
    return [];
  }
}
