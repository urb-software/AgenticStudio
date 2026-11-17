import { Inject, Injectable } from '@nestjs/common';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import type { RepositoryConnection } from '../../../domain/entities/repository-connection.js';
import type { RepositoryConnectionSnapshot } from '../../../domain/value-objects/repository-connection-snapshot.js';
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
import { ProjectNotFoundError } from '../../../domain/value-objects/project-errors.js';
import { NoRepositoryError } from '../../../domain/value-objects/repository-connection-errors.js';

export interface FetchRepositoryInput {
  projectId: string;
}

/** The Repository, now `fetching`. */
export type FetchRepositoryResult = RepositoryConnectionSnapshot;

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
   * Leaves `fetching` again, with the Clone's commit and fetch time the transition kept. The
   * failure comes from the read before it; if that read is stale (the Repository changed in
   * between), the Repository goes back to `ready`, never stays `fetching`.
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
