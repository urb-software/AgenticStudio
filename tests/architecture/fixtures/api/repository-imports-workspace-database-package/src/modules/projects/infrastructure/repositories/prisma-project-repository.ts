import type { DatabaseClient } from '@agentic-studio/database';
import type { ProjectRepository } from '../../domain/repositories/project-repository.js';

export class PrismaProjectRepository implements ProjectRepository {
  constructor(private readonly db: DatabaseClient) {}

  async add(name: string): Promise<void> {
    await this.db.project.create({ data: { name } });
  }
}
