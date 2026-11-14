import { Inject, Injectable } from '@nestjs/common';
import { isProjectId } from '../../domain/entities/project.js';
import type { RepositoryConnection } from '../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';
import { REPOSITORY_JOBS, type RepositoryJobs } from '../../ports/repository-jobs.js';
import { REPOSITORY_GIT, type RepositoryGit } from '../../ports/repository-git.js';

/**
 * Command: Fetch (glossary). Marks the Repository `fetching` and schedules the background
 * fetch; returns at once. Order: project id, platform, the store's transition (the real
 * duplicate guard: only from `ready`, or `failed` with a usable Clone), then the job. If the
 * job cannot be scheduled after the transition, the Repository gets its previous state back
 * (`ready`, or `failed` with its failure) and the error is rethrown, so nothing stays
 * `fetching` and nothing is lost.
 *
 * Throws {@link ProjectNotFoundError}, `GitUnsupportedPlatformError`, the store's
 * `NoRepositoryError` / `RepositoryBusyError` / `NoUsableCloneError`, and the queue's
 * `JobAlreadyActiveError` / `QueueUnavailableError`.
 */
@Injectable()
export class FetchRepositoryHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(REPOSITORY_JOBS) private readonly jobs: RepositoryJobs,
  ) {}

  async execute(projectId: string): Promise<RepositoryConnection> {
    if (!isProjectId(projectId)) throw new ProjectNotFoundError();
    this.git.assertSupported();

    const previous = await this.projects.findRepository(projectId);
    const repository = await this.projects.beginFetch(projectId);
    try {
      await this.jobs.start(projectId, 'fetch');
    } catch (error) {
      await this.restore(projectId, previous);
      throw error;
    }
    return repository;
  }

  /** Puts back the state the transition replaced (a Repository that could fetch has a Clone). */
  private async restore(projectId: string, previous: RepositoryConnection | null): Promise<void> {
    if (previous?.state === 'failed' && previous.failure) {
      await this.projects.markFetchFailed(projectId, previous.failure, { cloneKept: true });
    } else if (previous?.headSha && previous.lastFetchedAt) {
      await this.projects.markFetched(projectId, {
        headSha: previous.headSha,
        fetchedAt: previous.lastFetchedAt,
      });
    }
  }
}
