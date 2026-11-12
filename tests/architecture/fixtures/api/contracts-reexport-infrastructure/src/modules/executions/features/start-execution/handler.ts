import { PrismaProjectRepository } from '../../../projects/contracts/index.js';

export class StartExecutionHandler {
  constructor(private readonly projects: PrismaProjectRepository) {}

  async execute(projectId: string): Promise<string> {
    return this.projects.findName(projectId);
  }
}
