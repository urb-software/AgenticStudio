import { Project } from '../../../domain/entities/project.js';

export interface GetProjectInput {
  projectId: string;
}

export type GetProjectResult = Project;

export class GetProjectHandler {
  async execute(input: GetProjectInput): Promise<Project> {
    return Project.restore(input.projectId, 'Shop');
  }
}
