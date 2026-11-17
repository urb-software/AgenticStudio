import { Inject, Injectable } from '@nestjs/common';
import type { RunStartPoint, RunStartPoints } from '../../../contracts/index.js';
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

/** Where a Run of the project would start, or why there is no start point. */
export type GetRunStartPointResult = RunStartPoint;

/**
 * Query (Issue #96): the commit a Run of a project starts from, the remote it is fetched from
 * (Issue #98) and the integration branch its pull request targets (Issue #102), for
 * `executions` through the public {@link RunStartPoints} contract (`forProject` takes the id
 * and calls `execute`). Only a `ready` Repository qualifies: while it is being fetched, its
 * commit is about to change.
 */
@Injectable()
export class GetRunStartPointHandler implements RunStartPoints {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
  ) {}

  forProject(projectId: string): Promise<GetRunStartPointResult> {
    return this.execute({ projectId });
  }

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
