import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import { repositoryView, type RepositoryView } from '../../repository-view.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { REPOSITORY_GIT, type RepositoryGit } from '../../ports/repository-git.js';
import { REPOSITORY_JOBS, type RepositoryJobs } from '../../ports/repository-jobs.js';
import { RepositoryCleanup } from '../../repository-cleanup.js';
import { ProjectNotFoundError } from '../../../domain/errors/project-errors.js';
import { NoRepositoryError } from '../../../domain/errors/repository-connection-errors.js';

export interface DisconnectRepositoryInput {
  projectId: string;
}

export type DisconnectRepositoryResult =
  { disconnected: true } | { disconnected: false; repository: RepositoryView };

/**
 * A failed cleanup leaves the Repository `disconnecting` for a retry.
 */
@Injectable()
export class DisconnectRepositoryHandler {
  private readonly logger = new Logger('DisconnectRepository');

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(REPOSITORY_JOBS) private readonly jobs: RepositoryJobs,
    private readonly cleanup: RepositoryCleanup,
  ) {}

  async execute(input: DisconnectRepositoryInput): Promise<DisconnectRepositoryResult> {
    const { projectId } = input;
    if (!isProjectId(projectId)) throw new ProjectNotFoundError();
    this.git.assertSupported();

    const repository = await this.repositories.change(projectId, (stored) => {
      stored.startDisconnect();
    });
    if (!repository) {
      throw (await this.projects.findById(projectId))
        ? new NoRepositoryError()
        : new ProjectNotFoundError();
    }
    try {
      await this.jobs.cancel(projectId);
    } catch (error) {
      this.logPending(projectId, 'could not cancel its running operation', error);
      return { disconnected: false, repository: repositoryView(repository) };
    }
    if (await this.cleanup.finish(projectId)) return { disconnected: true };
    return { disconnected: false, repository: repositoryView(repository) };
  }

  private logPending(projectId: string, what: string, error: unknown): void {
    this.logger.warn(
      `Disconnect of project ${projectId}: ${what}; it stays disconnecting and is retried at ` +
        `start-up and on a repeated disconnect. ${redactSecrets(String(error))}`,
    );
  }
}
