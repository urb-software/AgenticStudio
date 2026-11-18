import type { DatabaseClient } from '../../../../../shared/db.js';

export type ListProjectsResult = string[];

export class ListProjectsHandler {
  constructor(private readonly db: DatabaseClient) {}

  async execute(): Promise<ListProjectsResult> {
    return this.db.projectNames();
  }
}
