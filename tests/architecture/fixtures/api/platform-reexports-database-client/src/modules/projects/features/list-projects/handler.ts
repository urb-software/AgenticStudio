import type { DatabaseClient } from '../../../../platform/http/db.js';

export class ListProjectsHandler {
  constructor(private readonly db: DatabaseClient) {}

  async execute(): Promise<string[]> {
    return this.db.projectNames();
  }
}
