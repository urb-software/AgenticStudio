import { Inject, Injectable } from '@nestjs/common';
import { NoTrustedHostKeyError } from '../../../domain/errors/repository-connection-errors.js';
import { RepositoryFailure } from '../../../domain/value-objects/repository-failure.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import {
  GitOperationError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';
import { DEPLOY_KEYS, type DeployKeys } from '../../ports/deploy-keys.js';

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function gitStepFailure(error: unknown): RepositoryFailure | undefined {
  if (error instanceof NoTrustedHostKeyError) {
    return RepositoryFailure.noTrustedHostKey();
  }
  if (error instanceof GitOperationError)
    return RepositoryFailure.fromGit(error.reason, error.detail);
  return undefined;
}

export interface CloneRepositoryInput {
  projectId: string;
  signal: AbortSignal;
}

@Injectable()
export class CloneRepositoryHandler {
  constructor(
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(DEPLOY_KEYS) private readonly deployKeys: DeployKeys,
  ) {}

  /** Runs one clone. Aborts propagate, so the queue reports them to the unfinished-job recording. */
  async execute(input: CloneRepositoryInput): Promise<void> {
    const { projectId, signal } = input;
    signal.throwIfAborted();
    const repository = await this.repositories.find(projectId);
    // A job left over from before a restart, whose attempt reconciliation already failed.
    if (repository?.pendingOperation !== 'clone') return;
    const { url, integrationBranch } = repository;
    try {
      const ssh = await this.deployKeys.credentials(repository);
      // Retry and every first clone start clean: a partial or stale Clone is removed first.
      await this.git.removeClone(projectId, { signal });
      const remote = await this.git.inspectRemote(url, integrationBranch, { signal, ssh });
      if (!remote.branchExists) {
        await this.fail(
          projectId,
          RepositoryFailure.of('branch_not_found', '', remote.defaultBranch),
        );
        return;
      }
      const { commit } = await this.git.clone(projectId, url, integrationBranch, { signal, ssh });
      signal.throwIfAborted();
      const clone = { headSha: commit, fetchedAt: new Date() };
      await this.repositories.change(projectId, (stored) => {
        stored.completeClone(clone);
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      const failure = gitStepFailure(error);
      if (failure) {
        await this.fail(projectId, failure);
        return;
      }
      // Unexpected (a rejected request, the database): the unfinished-job recording stores `unknown`.
      throw error;
    }
  }

  /** A late write changes nothing: only a Repository still `connecting` takes the failure. */
  private async fail(projectId: string, failure: RepositoryFailure): Promise<void> {
    await this.repositories.change(projectId, (stored) => {
      stored.failClone(failure);
    });
  }
}
