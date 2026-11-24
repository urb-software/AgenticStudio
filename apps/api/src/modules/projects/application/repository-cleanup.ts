import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../platform/http/redact.js';
import type { RepositoryConnection } from '../domain/entities/repository-connection.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../domain/repositories/repository-connection-repository.js';
import { REPOSITORY_DISCONNECT_STEPS, type RepositoryDisconnectSteps } from '../contracts/index.js';
import { DEPLOY_KEYS, type DeployKeys } from './ports/deploy-keys.js';
import { REPOSITORY_GIT, type RepositoryGit } from './ports/repository-git.js';

/** One thing a Disconnect removes; each step is idempotent, so a retry runs them all again. */
interface CleanupStep {
  readonly name: string;
  /** `pending`: the step started work another process finishes; a retry asks again. */
  run(repository: RepositoryConnection): Promise<void | 'done' | 'pending'>;
}

/**
 * The cleanup of a `disconnecting` Repository, shared by the operator's Disconnect and the
 * start-up resume. A failed or pending step leaves the Repository `disconnecting` for a retry;
 * the steps other modules added run first.
 */
@Injectable()
export class RepositoryCleanup {
  private readonly logger = new Logger('DisconnectRepository');
  private readonly steps: readonly CleanupStep[];

  constructor(
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) git: RepositoryGit,
    @Inject(DEPLOY_KEYS) deployKeys: DeployKeys,
    @Inject(REPOSITORY_DISCONNECT_STEPS) private readonly added: RepositoryDisconnectSteps,
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
    const addedSteps: CleanupStep[] = this.added.list().map((step) => ({
      name: step.name,
      run: (stored) => step.run(stored.projectId),
    }));
    for (const step of [...addedSteps, ...this.steps]) {
      try {
        if ((await step.run(repository)) === 'pending') {
          this.logPending(projectId, `the step to ${step.name} is not done`, 'pending');
          return false;
        }
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

  private logPending(projectId: string, what: string, error: unknown): void {
    this.logger.warn(
      `Disconnect of project ${projectId}: ${what}; it stays disconnecting and is retried every 30 s, ` +
        `at start-up and on a repeated disconnect. ${redactSecrets(String(error))}`,
    );
  }
}
