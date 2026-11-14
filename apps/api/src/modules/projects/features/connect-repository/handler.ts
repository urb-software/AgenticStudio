import { Inject, Injectable } from '@nestjs/common';
import { isProjectId } from '../../domain/entities/project.js';
import { type RepositoryConnection, repositoryFailure } from '../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';
import { IntegrationBranch } from '../../domain/value-objects/integration-branch.js';
import { RepositoryUrl } from '../../domain/value-objects/repository-url.js';
import { REPOSITORY_JOBS, type RepositoryJobs } from '../../ports/repository-jobs.js';
import { REPOSITORY_GIT, type RepositoryGit } from '../../ports/repository-git.js';

/** DI token for {@link ConnectRepositorySettings}. */
export const CONNECT_REPOSITORY_SETTINGS = Symbol('CONNECT_REPOSITORY_SETTINGS');

export interface ConnectRepositorySettings {
  /** The test-only fixture-remote setting (`STUDIO_GIT_ALLOW_FILE_REMOTES`, NODE_ENV=test only). */
  allowFileRemotes: boolean;
}

export interface ConnectRepositoryInput {
  projectId: string;
  url: string;
  integrationBranch: string;
}

/** Stored on the Repository when the clone could not be scheduled after it was stored. */
export const NOT_STARTED_DETAIL = 'The clone could not be started. Try again.';

/**
 * Command: Connect (glossary). Stores the Repository as `connecting` and schedules the
 * background clone; returns at once. Order: input (field errors on every platform), platform,
 * the store's transition (the real duplicate guard), then the job. If the job cannot be
 * scheduled after the transition, the attempt is marked `failed` again (keeping the reason and
 * detail of the failure a Retry replaced, else "could not be started") and the error is
 * rethrown, so nothing stays `connecting`.
 *
 * Throws `GitUnsupportedPlatformError`, `InvalidRepositoryUrlError`,
 * `InvalidIntegrationBranchError`, {@link ProjectNotFoundError}, the store's conflict
 * errors, and the queue's `JobAlreadyActiveError` / `QueueUnavailableError`.
 */
@Injectable()
export class ConnectRepositoryHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(REPOSITORY_JOBS) private readonly jobs: RepositoryJobs,
    @Inject(CONNECT_REPOSITORY_SETTINGS) private readonly settings: ConnectRepositorySettings,
  ) {}

  async execute(input: ConnectRepositoryInput): Promise<RepositoryConnection> {
    if (!isProjectId(input.projectId)) throw new ProjectNotFoundError();
    const url = RepositoryUrl.parse(input.url, {
      allowFileRemotes: this.settings.allowFileRemotes,
    });
    const branch = IntegrationBranch.parse(input.integrationBranch);
    this.git.assertSupported();

    // A Retry replaces a failed Repository; if the clone cannot be scheduled, its failure is kept.
    const previous = await this.projects.findRepository(input.projectId);
    const repository = await this.projects.beginConnect({
      projectId: input.projectId,
      url: url.value,
      identity: url.identity,
      integrationBranch: branch.value,
    });
    try {
      await this.jobs.start(input.projectId, 'clone');
    } catch (error) {
      await this.projects.markFailed(
        input.projectId,
        previous?.state === 'failed' && previous.failure
          ? previous.failure
          : repositoryFailure('unknown', NOT_STARTED_DETAIL),
      );
      throw error;
    }
    return repository;
  }
}
