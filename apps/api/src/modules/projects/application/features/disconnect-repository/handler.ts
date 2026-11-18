import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import type { RepositoryConnection } from '../../../domain/entities/repository-connection.js';
import { repositoryView, type RepositoryView } from '../../repository-view.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { DEPLOY_KEYS, type DeployKeys } from '../../ports/deploy-keys.js';
import { REPOSITORY_GIT, type RepositoryGit } from '../../ports/repository-git.js';
import { REPOSITORY_JOBS, type RepositoryJobs } from '../../ports/repository-jobs.js';
import { ProjectNotFoundError } from '../../../domain/errors/project-errors.js';
import { NoRepositoryError } from '../../../domain/errors/repository-connection-errors.js';

export interface DisconnectRepositoryInput {
  projectId: string;
}

export type DisconnectRepositoryResult =
  { disconnected: true } | { disconnected: false; repository: RepositoryView };

/** One thing a Disconnect removes; each step is idempotent, so a retry runs them all again. */
interface CleanupStep {
  readonly name: string;
  run(repository: RepositoryConnection): Promise<void>;
}

/**
 * A failed step leaves the Repository `disconnecting` for a retry.
 */
@Injectable()
export class DisconnectRepositoryHandler {
  private readonly logger = new Logger('DisconnectRepository');
  private readonly steps: readonly CleanupStep[];

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
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
          if (repository.holdsDeployKeyMaterial) {
            await repositories.change(repository.projectId, (stored) => {
              stored.forgetDeployKey();
            });
          }
        },
      },
    ];
  }

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
    if (await this.finish(projectId)) return { disconnected: true };
    return { disconnected: false, repository: repositoryView(repository) };
  }

  /**
   * Runs the cleanup steps in order, stopping at the first failure, then deletes the record. True
   * when nothing is left; false on a failure (logged, redacted): it stays `disconnecting`. Never throws.
   */
  async finish(projectId: string): Promise<boolean> {
    let repository: RepositoryConnection | null;
    try {
      repository = await this.repositories.find(projectId);
      if (!repository) return true;
      if (!repository.isDisconnecting) return false;
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
      await this.repositories.change(projectId, (stored) => {
        stored.finishDisconnect();
      });
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
    for (const projectId of await this.repositories.listIdsInState('disconnecting')) {
      try {
        await this.finish(projectId);
      } catch (error) {
        this.logPending(projectId, 'could not finish', error);
      }
    }
  }

  private logPending(projectId: string, what: string, error: unknown): void {
    this.logger.warn(
      `Disconnect of project ${projectId}: ${what}; it stays disconnecting and is retried at ` +
        `start-up and on a repeated disconnect. ${redactSecrets(String(error))}`,
    );
  }
}
