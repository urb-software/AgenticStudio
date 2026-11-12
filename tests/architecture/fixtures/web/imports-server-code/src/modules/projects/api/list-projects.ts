import { createDatabaseClient } from '@agentic-studio/database';

export async function listProjects(url: string): Promise<unknown> {
  return createDatabaseClient(url);
}
