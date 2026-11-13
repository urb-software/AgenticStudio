import { createDatabaseClient } from '@agentic-studio/database';

export class PrismaProjectRepository {
  readonly create = createDatabaseClient;
}
