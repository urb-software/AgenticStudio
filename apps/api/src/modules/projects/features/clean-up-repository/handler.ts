import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';
import { REPOSITORY_GIT, type RepositoryGit } from '../../ports/repository-git.js';

/** One thing a Disconnect removes; each step is idempotent, so a retry runs them all again. */
interface CleanupStep {
  /** What the step does, for the log ("remove the Clone"). */
  readonly name: string;
  run(projectId: string): Promise<void>;
}

/**
 * Feature: removing what Studio holds of a `disconnecting` Repository (Issue #63), used by the
 * Disconnect command and, at start-up, for every Repository a crash or an earlier failure left
 * `disconnecting`.
 *
 * The steps run in order and stop at the first failure, which is logged (redacted) and leaves
 * the Repository `disconnecting` for a retry; the record is deleted last, which also frees its
 * remote for another connect. Files are removed only through the Git adapter's
 * `removeClone(projectId)`, which derives the Clone's path from the project id and checks it
 * is inside the data directory; no path from a request or the database is used.
 *
 * The Deploy-key story (#62) adds its steps here (the private key in the secret store, the
 * pinned host key), each a no-op when the Repository has none.
 */
@Injectable()
export class CleanUpRepositoryHandler {
  private readonly logger = new Logger('DisconnectRepository');
  private readonly steps: readonly CleanupStep[];

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_GIT) git: RepositoryGit,
  ) {
    this.steps = [{ name: 'remove the Clone', run: (projectId) => git.removeClone(projectId) }];
  }

  /**
   * Runs every cleanup step of a `disconnecting` Repository, then deletes its record. True when
   * nothing of the Repository is left (also when the record was already gone); false when a
   * step failed (logged) or the Repository is not `disconnecting`.
   */
  async finish(projectId: string): Promise<boolean> {
    const repository = await this.projects.findRepository(projectId);
    if (!repository) return true;
    if (repository.state !== 'disconnecting') return false;
    for (const step of this.steps) {
      try {
        await step.run(projectId);
      } catch (error) {
        this.warn(projectId, `could not ${step.name}`, error);
        return false;
      }
    }
    // Zero rows means a concurrent cleanup deleted it first: nothing is left either way.
    await this.projects.deleteDisconnecting(projectId);
    return true;
  }

  /**
   * Start-up: resumes the cleanup of every `disconnecting` Repository. Runs after the Git
   * adapter's sweep and before the repository worker starts; never throws, so one Repository
   * that still cannot be cleaned up does not stop the others or the start-up.
   */
  async resumeAll(): Promise<void> {
    for (const projectId of await this.projects.listDisconnecting()) {
      try {
        await this.finish(projectId);
      } catch (error) {
        this.warn(projectId, 'could not finish', error);
      }
    }
  }

  private warn(projectId: string, what: string, error: unknown): void {
    this.logger.warn(
      `Disconnect of project ${projectId}: ${what}; it stays disconnecting and is retried at ` +
        `start-up and on a repeated disconnect. ${redactSecrets(String(error))}`,
    );
  }
}
