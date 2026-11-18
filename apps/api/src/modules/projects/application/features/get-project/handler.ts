import { Inject, Injectable } from '@nestjs/common';
import { projectView, type ProjectView } from '../../project-view.js';
import type { RepositoryState } from '../../../domain/value-objects/repository-state.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import { ProjectNotFoundError } from '../../../domain/errors/project-errors.js';

export interface GetProjectInput {
  projectId: string;
}

export interface GetProjectResult {
  project: ProjectView;
  repository: { state: RepositoryState; url: string; integrationBranch: string } | null;
}

/**
 * Throws {@link ProjectNotFoundError} for an unknown project.
 */
@Injectable()
export class GetProjectHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
  ) {}

  async execute(input: GetProjectInput): Promise<GetProjectResult> {
    const { projectId } = input;
    if (!isProjectId(projectId)) throw new ProjectNotFoundError();
    const project = await this.projects.findById(projectId);
    if (!project) throw new ProjectNotFoundError();
    const repository = await this.repositories.find(projectId);
    return {
      project: projectView(project),
      repository: repository
        ? {
            state: repository.state,
            url: repository.url,
            integrationBranch: repository.integrationBranch,
          }
        : null,
    };
  }
}
