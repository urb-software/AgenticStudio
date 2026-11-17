import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { NoTrustedHostKeyError } from '../../../domain/entities/repository.js';
import {
  RepositoryFailure,
  type UnfinishedJob,
} from '../../../domain/value-objects/repository-failure.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  GitOperationError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';
import { DEPLOY_KEYS, type DeployKeys } from '../../ports/deploy-keys.js';

/** Whether `error` is the abort of the job's signal; a processor rethrows it to the queue. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * The failure of a Git step of the job, or `undefined` when `error` is not a Git failure (it
 * is then unexpected, and the queue reports it). No trusted host key is a `host_key_mismatch`
 * before Git runs (Issue #62); a Git failure keeps its reason and redacted output.
 */
function gitStepFailure(error: unknown): RepositoryFailure | undefined {
  if (error instanceof NoTrustedHostKeyError) {
    return RepositoryFailure.noTrustedHostKey();
  }
  if (error instanceof GitOperationError)
    return RepositoryFailure.fromGit(error.reason, error.detail);
  return undefined;
}

/**
 * Feature: the background clone of a connecting Repository, run by the Repository's job
 * (the job processor under `entry-points/jobs/` calls this for a `connecting` Repository).
 *
 * - `reconcile` (start-up, before the worker) fails every Repository still `connecting`:
 *   those whose job was interrupted and those whose job never ran (#60 clarification 4).
 * - A job removes any leftover Clone, inspects the remote (so `branch_not_found` can name the
 *   remote's default branch), clones, then marks the Repository `ready` or `failed`. Every
 *   write is conditional on the Repository still being `connecting`.
 * - An SSH Repository (Issue #62) uses its Deploy key, read from the secret store for this
 *   job only, and only its trusted host keys (configured or pinned); with none trusted it
 *   fails with `host_key_mismatch` before Git runs.
 */
@Injectable()
export class CloneRepositoryHandler {
  private readonly logger = new Logger('CloneRepository');

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(DEPLOY_KEYS) private readonly deployKeys: DeployKeys,
  ) {}

  /** Runs one clone. Aborts propagate, so the queue reports them through `onFailed`. */
  async process(projectId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const repository = await this.projects.findRepository(projectId);
    // A job left over from before a restart, whose attempt reconciliation already failed.
    if (repository?.pendingOperation !== 'clone') return;
    const { url, integrationBranch } = repository;
    try {
      const ssh = await this.deployKeys.credentials(repository);
      // Retry and every first clone start clean: a partial or stale Clone is removed first.
      await this.git.removeClone(projectId, { signal });
      const remote = await this.git.inspectRemote(url, integrationBranch, { signal, ssh });
      if (!remote.branchExists) {
        // No Git output to show: the code and the default branch say it all (#72).
        await this.fail(
          projectId,
          RepositoryFailure.of('branch_not_found', '', remote.defaultBranch),
        );
        return;
      }
      const { commit } = await this.git.clone(projectId, url, integrationBranch, { signal, ssh });
      signal.throwIfAborted();
      const clone = { headSha: commit, fetchedAt: new Date() };
      await this.projects.change(projectId, (stored) => {
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
    for (const projectId of await this.projects.listIdsInState('connecting')) {
      await this.projects.change(projectId, (stored) => {
        if (stored.failClone(RepositoryFailure.interrupted())) failed += 1;
      });
    }
    if (failed > 0) {
      this.logger.warn(`Marked ${failed} interrupted repository connection(s) as failed.`);
    }
  }

  /** A late write changes nothing: only a Repository still `connecting` takes the failure. */
  private async fail(projectId: string, failure: RepositoryFailure): Promise<void> {
    await this.projects.change(projectId, (stored) => {
      stored.failClone(failure);
    });
  }
}
