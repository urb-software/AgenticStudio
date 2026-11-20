import { Inject, Injectable } from '@nestjs/common';
import type { RunStartPoint } from '../../../contracts/index.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';

export interface GetRunStartPointInput {
  projectId: string;
}

export type GetRunStartPointResult = RunStartPoint;

/**
 * Only a `ready` Repository qualifies: while it is fetching, its commit is about to change.
 */
@Injectable()
export class GetRunStartPointHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
  ) {}

  async execute(input: GetRunStartPointInput): Promise<GetRunStartPointResult> {
    const { projectId } = input;
    if (!isProjectId(projectId) || !(await this.projects.findById(projectId))) {
      return { status: 'project_not_found' };
    }
    const repository = await this.repositories.find(projectId);
    if (!repository) return { status: 'no_repository' };
    if (repository.state !== 'ready' || repository.headSha === null) {
      return { status: 'repository_not_ready' };
    }
    return {
      status: 'ready',
      startCommit: repository.headSha,
      remoteUrl: repository.url,
      integrationBranch: repository.integrationBranch,
    };
  }
}
