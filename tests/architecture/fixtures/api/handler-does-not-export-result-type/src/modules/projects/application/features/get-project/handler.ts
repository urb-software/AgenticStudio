import type { ProjectSnapshot } from '../../../domain/entities/project.js';

export interface GetProjectInput {
  projectId: string;
}

export class GetProjectHandler {
  async execute(input: GetProjectInput): Promise<ProjectSnapshot> {
    return { id: input.projectId, name: 'Shop' };
  }
}
