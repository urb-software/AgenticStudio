import { PrismaProjectRepository } from '../../../helpers.js';

export type RenameProjectInput = string;
export type RenameProjectResult = string;

export class RenameProjectHandler {
  constructor(private readonly projects: PrismaProjectRepository) {}

  async execute(projectId: RenameProjectInput): Promise<RenameProjectResult> {
    return this.projects.findName(projectId);
  }
}
