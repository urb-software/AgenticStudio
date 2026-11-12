import type { DatabaseClient } from '../../../projects/contracts/index.js';

export class StartExecutionHandler {
  constructor(private readonly db: DatabaseClient) {}

  async execute(): Promise<number> {
    return (await this.db.projectNames()).length;
  }
}
