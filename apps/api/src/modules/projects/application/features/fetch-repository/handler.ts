import { Inject, Injectable } from '@nestjs/common';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import type { RepositoryConnection } from '../../../domain/entities/repository-connection.js';
import type { RepositoryConnectionSnapshot } from '../../../domain/entities/repository-connection-snapshot.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { REPOSITORY_JOBS, type RepositoryJobs } from '../../ports/repository-jobs.js';
import { REPOSITORY_GIT, type RepositoryGit } from '../../ports/repository-git.js';
import { ProjectNotFoundError } from '../../../domain/errors/project-errors.js';
import { NoRepositoryError } from '../../../domain/errors/repository-connection-errors.js';

export interface FetchRepositoryInput {
  projectId: string;
}

export type FetchRepositoryResult = RepositoryConnectionSnapshot;

/**
 * If the fetch job cannot be scheduled, the previous state is restored and the error rethrown.
 */
@Injectable()
export class FetchRepositoryHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(REPOSITORY_JOBS) private readonly jobs: RepositoryJobs,
  ) {}

  async execute(input: FetchRepositoryInput): Promise<FetchRepositoryResult> {
    const { projectId } = input;
    if (!isProjectId(projectId)) throw new ProjectNotFoundError();
    this.git.assertSupported();

    // Only for the failure a restore puts back; the transition below is the real guard.
    const before = await this.repositories.find(projectId);
    const repository = await this.repositories.change(projectId, (stored) => {
      stored.startFetch();
    });
    if (!repository) {
      throw (await this.projects.findById(projectId))
        ? new NoRepositoryError()
        : new ProjectNotFoundError();
    }
    try {
      await this.jobs.start(projectId, 'fetch');
    } catch (error) {
      await this.leaveFetching(projectId, before);
      throw error;
    }
    return repository.snapshot();
  }

  /**
   * Leaves `fetching` again, keeping the Clone's commit and fetch time; a stale failure read
   * goes back to `ready`, never stays `fetching`.
   */
  private async leaveFetching(
    projectId: string,
    before: RepositoryConnection | null,
  ): Promise<void> {
    await this.repositories.change(projectId, (stored) => {
      stored.revertFetch(before?.failure ?? null);
    });
  }
}
