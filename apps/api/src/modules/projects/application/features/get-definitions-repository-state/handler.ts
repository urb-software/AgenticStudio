import { Inject, Injectable } from '@nestjs/common';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import type { RepositoryState } from '../../../domain/value-objects/repository-state.js';

export interface GetDefinitionsRepositoryStateResult {
  projectId: string;
  repository: {
    state: RepositoryState;
    integrationBranch: string;
    headSha: string | null;
    lastFetchedAt: Date | null;
  } | null;
}

/** `null` when no definitions Project exists. */
@Injectable()
export class GetDefinitionsRepositoryStateHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
  ) {}

  async execute(): Promise<GetDefinitionsRepositoryStateResult | null> {
    const project = await this.projects.findDefinitions();
    if (!project) return null;
    const repository = await this.repositories.find(project.id);
    return {
      projectId: project.id,
      repository: repository
        ? {
            state: repository.state,
            integrationBranch: repository.integrationBranch,
            headSha: repository.headSha,
            lastFetchedAt: repository.lastFetchedAt,
          }
        : null,
    };
  }
}
