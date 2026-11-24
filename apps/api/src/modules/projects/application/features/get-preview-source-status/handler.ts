import { Inject, Injectable } from '@nestjs/common';
import type { PreviewSourceStatus } from '../../../contracts/index.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import {
  GitUnsupportedPlatformError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';

export interface GetPreviewSourceStatusInput {
  projectId: string;
}

export type GetPreviewSourceStatusResult = PreviewSourceStatus;

/** Whether a Preview can read the Project's Repository: only a `ready` one, on a Linux host. */
@Injectable()
export class GetPreviewSourceStatusHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
  ) {}

  async execute(input: GetPreviewSourceStatusInput): Promise<GetPreviewSourceStatusResult> {
    const { projectId } = input;
    if (!isProjectId(projectId) || !(await this.projects.findById(projectId))) {
      return { status: 'project_not_found' };
    }
    const repository = await this.repositories.find(projectId);
    if (!repository) return { status: 'no_repository' };
    if (repository.state !== 'ready' || repository.headSha === null) {
      return { status: 'repository_not_ready' };
    }
    try {
      this.git.assertSupported();
    } catch (error) {
      if (error instanceof GitUnsupportedPlatformError) return { status: 'unsupported_platform' };
      throw error;
    }
    return { status: 'ready', commit: repository.headSha, fetchedAt: repository.lastFetchedAt };
  }
}
