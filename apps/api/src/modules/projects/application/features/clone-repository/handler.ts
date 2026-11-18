import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { NoTrustedHostKeyError } from '../../../domain/errors/repository-connection-errors.js';
import { RepositoryFailure } from '../../../domain/value-objects/repository-failure.js';
import { type UnfinishedJob } from '../../../domain/value-objects/unfinished-job.js';
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
  private readonly logger = new Logger('CloneRepository');

  constructor(
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(DEPLOY_KEYS) private readonly deployKeys: DeployKeys,
  ) {}

  /** Runs one clone. Aborts propagate, so the queue reports them through `onFailed`. */
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
      // Unexpected (a rejected request, the database): `onFailed` stores `unknown`.
      throw error;
    }
  }

  async onFailed(projectId: string, failure: UnfinishedJob): Promise<void> {
    if (failure.reason === 'error') {
      this.logger.error(
        `Clone of project ${projectId} failed unexpectedly: ${redactSecrets(String(failure.error))}`,
      );
    }
    await this.fail(projectId, RepositoryFailure.fromUnfinishedJob('clone', failure));
  }

  /** Idempotent: failing what is already failed changes nothing. */
  async reconcile(): Promise<void> {
    let failed = 0;
    for (const projectId of await this.repositories.listIdsInState('connecting')) {
      await this.repositories.change(projectId, (stored) => {
        if (stored.failClone(RepositoryFailure.interrupted())) failed += 1;
      });
    }
    if (failed > 0) {
      this.logger.warn(`Marked ${failed} interrupted repository connection(s) as failed.`);
    }
  }

  /** A late write changes nothing: only a Repository still `connecting` takes the failure. */
  private async fail(projectId: string, failure: RepositoryFailure): Promise<void> {
    await this.repositories.change(projectId, (stored) => {
      stored.failClone(failure);
    });
  }
}
