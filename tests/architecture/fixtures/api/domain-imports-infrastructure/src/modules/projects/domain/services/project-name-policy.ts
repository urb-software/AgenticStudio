import { PrismaProjectRepository } from '../../infrastructure/repositories/prisma-project-repository.js';

export class ProjectNamePolicy {
  constructor(private readonly projects: PrismaProjectRepository) {}

  async isFree(name: string): Promise<boolean> {
    return !(await this.projects.existsByName(name));
  }
}
