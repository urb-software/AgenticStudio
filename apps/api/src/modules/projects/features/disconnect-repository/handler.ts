import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { isProjectId } from '../../domain/entities/project.js';
import type { RepositoryConnection } from '../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';
import { REPOSITORY_GIT, type RepositoryGit } from '../../ports/repository-git.js';
import { REPOSITORY_JOBS, type RepositoryJobs } from '../../ports/repository-jobs.js';
import { CleanUpRepositoryHandler } from '../clean-up-repository/handler.js';

/** What a disconnect achieved: everything removed, or cleanup still pending. */
export type DisconnectOutcome =
  { disconnected: true } | { disconnected: false; repository: RepositoryConnection };

/**
 * Command: Disconnect (glossary), Studio's first destructive action (Issue #63). Order:
 *
 * 1. project id and platform (nothing changes on a host that is not Linux);
 * 2. the Repository → `disconnecting`, in any state: the guard that keeps a running job from
 *    writing `ready` or `failed` afterwards (its transitions apply only from `connecting` or
 *    `fetching`);
 * 3. the Repository's job is cancelled and waited for, so its id is free for a later connect
 *    and no late write of it can touch a new Repository;
 * 4. the cleanup steps (the Clone, then what later stories add) and the record, last.
 *
 * A failure in 3 or 4 is logged (redacted) and leaves the Repository `disconnecting`; the
 * outcome then says cleanup is pending. A repeated disconnect and start-up retry it.
 * Disconnect wins over a running connect or fetch: it is never refused as busy.
 *
 * Throws {@link ProjectNotFoundError}, `GitUnsupportedPlatformError` and the store's
 * `NoRepositoryError`.
 */
@Injectable()
export class DisconnectRepositoryHandler {
  private readonly logger = new Logger('DisconnectRepository');

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(REPOSITORY_JOBS) private readonly jobs: RepositoryJobs,
    private readonly cleanup: CleanUpRepositoryHandler,
  ) {}

  async execute(projectId: string): Promise<DisconnectOutcome> {
    if (!isProjectId(projectId)) throw new ProjectNotFoundError();
    this.git.assertSupported();

    const repository = await this.projects.beginDisconnect(projectId);
    try {
      await this.jobs.cancel(projectId);
    } catch (error) {
      this.logger.warn(
        `Disconnect of project ${projectId}: could not cancel its running operation; it stays ` +
          `disconnecting and is retried at start-up and on a repeated disconnect. ` +
          redactSecrets(String(error)),
      );
      return { disconnected: false, repository };
    }
    if (await this.cleanup.finish(projectId)) return { disconnected: true };
    return { disconnected: false, repository };
  }
}
