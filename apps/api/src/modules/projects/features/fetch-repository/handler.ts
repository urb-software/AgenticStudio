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

    // Only for the failure a restore puts back; the transition below is the real guard.
    const before = await this.projects.findRepository(projectId);
    const repository = await this.projects.beginFetch(projectId);
    try {
      await this.jobs.start(projectId, 'fetch');
    } catch (error) {
      await this.restore(repository, before);
      throw error;
    }
    return repository;
  }

  /**
   * Leaves `fetching` again, with the Clone's commit and fetch time from the transition itself
   * (always set: only a Repository with a Clone can start a fetch). The failure comes from the
   * read before it; if that read is stale (the Repository changed in between), the
   * Repository goes back to `ready`, never stays `fetching`.
   */
  private async restore(
    repository: RepositoryConnection,
    before: RepositoryConnection | null,
  ): Promise<void> {
    const { projectId, headSha, lastFetchedAt } = repository;
    if (before?.state === 'failed' && before.failure) {
      await this.projects.markFetchFailed(projectId, before.failure, { cloneKept: true });
    } else if (headSha && lastFetchedAt) {
      await this.projects.markFetched(projectId, { headSha, fetchedAt: lastFetchedAt });
    }
  }
}
