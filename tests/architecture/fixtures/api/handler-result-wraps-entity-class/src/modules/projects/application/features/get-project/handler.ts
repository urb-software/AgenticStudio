import { Project } from '../../../domain/entities/project.js';

export interface GetProjectInput {
  projectId: string;
}

export interface GetProjectResult {
  project: Project;
}

export class GetProjectHandler {
  async execute(input: GetProjectInput): Promise<GetProjectResult> {
    return { project: Project.restore(input.projectId, 'Shop') };
  }
}
