import type { DatabaseClient } from '../../../../platform/database/database.module.js';

export class ListProjectsHandler {
  constructor(private readonly db: DatabaseClient) {}

  async execute(): Promise<string[]> {
    return this.db.projectNames();
  }
}
