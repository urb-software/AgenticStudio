import type { ProjectSnapshot } from '../../../domain/entities/project.js';

export interface GetProjectInput {
  projectId: string;
}

export type GetProjectResult = ProjectSnapshot;

export class GetProjectHandler {
  async execute(input: GetProjectInput): Promise<GetProjectResult> {
    return { id: input.projectId, name: 'Shop' };
  }
}
