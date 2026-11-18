import { PrismaProjectRepository } from '../../../../projects/infrastructure/repositories/prisma-project-repository.js';

export type StartExecutionInput = string;
export type StartExecutionResult = boolean;

export class StartExecutionHandler {
  constructor(private readonly projects: PrismaProjectRepository) {}

  async execute(projectId: StartExecutionInput): Promise<StartExecutionResult> {
    return this.projects.exists(projectId);
  }
}
