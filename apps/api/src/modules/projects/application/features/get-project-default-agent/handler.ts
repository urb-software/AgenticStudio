import { Inject, Injectable } from '@nestjs/common';
import type { ProjectDefaultAgent } from '../../../contracts/index.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';

export interface GetProjectDefaultAgentInput {
  projectId: string;
}

export type GetProjectDefaultAgentResult = ProjectDefaultAgent;

/** The Project's default agent as stored, for `agents`; an id that is not a UUID names no project. */
@Injectable()
export class GetProjectDefaultAgentHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(input: GetProjectDefaultAgentInput): Promise<GetProjectDefaultAgentResult> {
    const project = isProjectId(input.projectId)
      ? await this.projects.findById(input.projectId)
      : null;
    if (!project) return { status: 'project_not_found' };
    return {
      status: 'found',
      kind: project.kind,
      agent: project.defaultAgent,
      workflow: project.defaultWorkflow,
    };
  }
}
