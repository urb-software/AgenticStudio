import { Inject, Injectable } from '@nestjs/common';
import { isProjectId } from '../../domain/entities/project.js';
import { type Repository, repositoryFailure } from '../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';
import { IntegrationBranch } from '../../domain/value-objects/integration-branch.js';
import { RepositoryUrl } from '../../domain/value-objects/repository-url.js';
import { CLONE_JOBS, type CloneJobs } from '../../ports/clone-jobs.js';
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
 * scheduled after the transition, the attempt is marked `failed` and the error is rethrown,
 * so nothing stays `connecting`.
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
    @Inject(CLONE_JOBS) private readonly cloneJobs: CloneJobs,
    @Inject(CONNECT_REPOSITORY_SETTINGS) private readonly settings: ConnectRepositorySettings,
  ) {}

  async execute(input: ConnectRepositoryInput): Promise<Repository> {
    if (!isProjectId(input.projectId)) throw new ProjectNotFoundError();
    const url = RepositoryUrl.parse(input.url, {
      allowFileRemotes: this.settings.allowFileRemotes,
    });
    const branch = IntegrationBranch.parse(input.integrationBranch);
    this.git.assertSupported();

    const repository = await this.projects.beginConnect({
      projectId: input.projectId,
      url: url.value,
      identity: url.identity,
      integrationBranch: branch.value,
    });
    try {
      await this.cloneJobs.start(input.projectId);
    } catch (error) {
      await this.projects.markFailed(
        input.projectId,
        repositoryFailure('unknown', NOT_STARTED_DETAIL),
      );
      throw error;
    }
    return repository;
  }
}
