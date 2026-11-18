import * as common from '@nestjs/common';

export type ListProjectsResult = string[];

export class ListProjectsHandler {
  readonly decorators = common;

  async execute(): Promise<ListProjectsResult> {
    return [];
  }
}
