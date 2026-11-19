import type { ProjectView } from '../../../domain/entities/project.js';

export interface GetProjectInput {
  projectId: string;
}

export class GetProjectHandler {
  async execute(input: GetProjectInput): Promise<ProjectView> {
    return { id: input.projectId, name: 'Shop' };
  }
}
