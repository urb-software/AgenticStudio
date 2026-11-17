import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { isProjectId } from '../../../domain/entities/project.js';
import type { RepositoryConnection } from '../../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import { DEPLOY_KEYS, type DeployKeys } from '../../ports/deploy-keys.js';
import { REPOSITORY_GIT, type RepositoryGit } from '../../ports/repository-git.js';
import { REPOSITORY_JOBS, type RepositoryJobs } from '../../ports/repository-jobs.js';

/** What a disconnect achieved: everything removed, or cleanup still pending. */
export type DisconnectOutcome =
  { disconnected: true } | { disconnected: false; repository: RepositoryConnection };

/** One thing a Disconnect removes; each step is idempotent, so a retry runs them all again. */
interface CleanupStep {
  /** What the step does, for the log ("remove the Clone"). */
  readonly name: string;
  run(repository: RepositoryConnection): Promise<void>;
}

/**
 * Command: Disconnect (glossary), Studio's first destructive action (Issue #63). One use case
 * with two entry points: the HTTP endpoint calls {@link execute}, and start-up calls
 * {@link resumeAll} for every Repository a crash or an earlier failure left `disconnecting`.
 * Order of {@link execute}:
 *
 * 1. project id and platform (nothing changes on a host that is not Linux);
 * 2. the Repository → `disconnecting`, in any state: the guard that keeps a running job from
 *    writing `ready` or `failed` afterwards (its transitions apply only from `connecting` or
 *    `fetching`);
 * 3. the Repository's job is cancelled and waited for, so its id is free for a later connect
 *    and no late write of it can touch a new Repository;
 * 4. the cleanup steps ({@link finish}): the Clone, the Deploy key (#62), and the record, last.
 *
 * The cleanup steps run in order and stop at the first failure, which is logged (redacted) and
 * leaves the Repository `disconnecting` for a retry; deleting the record also frees its remote
 * for another connect. Files are removed only through the Git adapter's
 * `removeClone(projectId)`, which derives the Clone's path from the project id and checks it
 * is inside the data directory; no path from a request or the database is used. The Deploy-key
 * steps remove the private key in the secret store, then the Repository's reference to it, its
 * public key and its pinned (or pending) host key; each is a no-op when the Repository has
 * none, so an HTTPS Repository skips them.
 *
 * A failure in 3 or 4 leaves the Repository `disconnecting`; the outcome then says cleanup is
 * pending. A repeated disconnect and start-up retry it. Disconnect wins over a running connect
 * or fetch: it is never refused as busy.
 *
 * Throws {@link ProjectNotFoundError}, `GitUnsupportedPlatformError` and the store's
 * `NoRepositoryError`.
 */
@Injectable()
export class DisconnectRepositoryHandler {
  private readonly logger = new Logger('DisconnectRepository');
  private readonly steps: readonly CleanupStep[];

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(REPOSITORY_JOBS) private readonly jobs: RepositoryJobs,
    @Inject(DEPLOY_KEYS) deployKeys: DeployKeys,
  ) {
    this.steps = [
      { name: 'remove the Clone', run: (repository) => git.removeClone(repository.projectId) },
      {
        name: 'delete the Deploy key',
        run: async ({ deployKeySecret }) => {
          if (deployKeySecret !== null) await deployKeys.remove(deployKeySecret);
        },
      },
      {
        name: 'forget the Deploy key and the pinned host key',
        run: async (repository) => {
          if (
            repository.deployKeySecret !== null ||
            repository.publicKey !== null ||
            repository.pinnedHostKey !== null ||
            repository.pendingHostKey !== null
          ) {
            await projects.forgetDeployKey(repository.projectId);
          }
        },
      },
    ];
  }

  async execute(projectId: string): Promise<DisconnectOutcome> {
    if (!isProjectId(projectId)) throw new ProjectNotFoundError();
    this.git.assertSupported();

    const repository = await this.projects.beginDisconnect(projectId);
    try {
      await this.jobs.cancel(projectId);
    } catch (error) {
      this.logPending(projectId, 'could not cancel its running operation', error);
      return { disconnected: false, repository };
    }
    if (await this.finish(projectId)) return { disconnected: true };
    return { disconnected: false, repository };
  }

  /**
   * Runs every cleanup step of a `disconnecting` Repository, then deletes its record. True when
   * nothing of the Repository is left (also when the record was already gone); false when a
   * step or the store failed (logged, redacted) or the Repository is not `disconnecting`.
   * Never throws: a failure leaves the Repository `disconnecting` for a retry.
   */
  async finish(projectId: string): Promise<boolean> {
    let repository: RepositoryConnection | null;
    try {
      repository = await this.projects.findRepository(projectId);
      if (!repository) return true;
      if (repository.state !== 'disconnecting') return false;
    } catch (error) {
      this.logPending(projectId, 'could not read the repository', error);
      return false;
    }
    for (const step of this.steps) {
      try {
        await step.run(repository);
      } catch (error) {
        this.logPending(projectId, `could not ${step.name}`, error);
        return false;
      }
    }
    try {
      // Zero rows means a concurrent cleanup deleted it first: nothing is left either way.
      await this.projects.deleteDisconnecting(projectId);
    } catch (error) {
      this.logPending(projectId, 'could not delete the repository record', error);
      return false;
    }
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
        this.logPending(projectId, 'could not finish', error);
      }
    }
  }

  /** Logs (redacted) why a Disconnect of the project stays pending. */
  private logPending(projectId: string, what: string, error: unknown): void {
    this.logger.warn(
      `Disconnect of project ${projectId}: ${what}; it stays disconnecting and is retried at ` +
        `start-up and on a repeated disconnect. ${redactSecrets(String(error))}`,
    );
  }
}
