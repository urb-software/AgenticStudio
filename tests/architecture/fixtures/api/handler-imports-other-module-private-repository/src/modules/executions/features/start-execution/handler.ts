import { PrismaProjectRepository } from '../../../projects/infrastructure/repositories/prisma-project-repository.js';

export class StartExecutionHandler {
  constructor(private readonly projects: PrismaProjectRepository) {}

  async execute(projectId: string): Promise<boolean> {
    return this.projects.exists(projectId);
  }
}
