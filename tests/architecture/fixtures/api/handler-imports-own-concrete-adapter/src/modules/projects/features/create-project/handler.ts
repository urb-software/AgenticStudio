import { PrismaProjectRepository } from '../../infrastructure/repositories/prisma-project-repository.js';

export class CreateProjectHandler {
  constructor(private readonly projects: PrismaProjectRepository) {}

  async execute(name: string): Promise<void> {
    await this.projects.add(name);
  }
}
