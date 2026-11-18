import { PrismaProjectRepository } from '../../../../projects/contracts/index.js';

export type StartExecutionInput = string;
export type StartExecutionResult = string;

export class StartExecutionHandler {
  constructor(private readonly projects: PrismaProjectRepository) {}

  async execute(projectId: StartExecutionInput): Promise<StartExecutionResult> {
    return this.projects.findName(projectId);
  }
}
