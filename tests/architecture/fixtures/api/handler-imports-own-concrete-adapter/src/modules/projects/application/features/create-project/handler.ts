import { PrismaProjectRepository } from '../../../infrastructure/repositories/prisma-project-repository.js';

export type CreateProjectInput = string;

export class CreateProjectHandler {
  constructor(private readonly projects: PrismaProjectRepository) {}

  async execute(name: CreateProjectInput): Promise<void> {
    await this.projects.add(name);
  }
}
