import { PrismaProjectRepository } from '../../helpers.js';

export class RenameProjectHandler {
  constructor(private readonly projects: PrismaProjectRepository) {}

  async execute(projectId: string): Promise<string> {
    return this.projects.findName(projectId);
  }
}
