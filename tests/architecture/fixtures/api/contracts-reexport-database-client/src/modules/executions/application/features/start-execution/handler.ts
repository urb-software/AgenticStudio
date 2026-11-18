import type { DatabaseClient } from '../../../../projects/contracts/index.js';

export type StartExecutionResult = number;

export class StartExecutionHandler {
  constructor(private readonly db: DatabaseClient) {}

  async execute(): Promise<StartExecutionResult> {
    return (await this.db.projectNames()).length;
  }
}
