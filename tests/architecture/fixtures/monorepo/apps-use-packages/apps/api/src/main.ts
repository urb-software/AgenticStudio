import { createDatabaseClient } from '@agentic-studio/database';
import { deployMigrations } from '@agentic-studio/database/migrations';

export async function main(url: string): Promise<void> {
  await deployMigrations(url);
  createDatabaseClient(url);
}
