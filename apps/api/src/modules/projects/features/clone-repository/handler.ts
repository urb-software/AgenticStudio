import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import type { JobFailure } from '../../../../platform/queue/job-queue.js';
import { INTERRUPTED_DETAIL, repositoryFailure } from '../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';
import { REPOSITORY_GIT, type RepositoryGit } from '../../ports/repository-git.js';
import { DeployKeyHandler } from '../deploy-key/handler.js';
import {
  gitStepFailure,
  isAbortError,
  unfinishedJobFailure,
} from '../repository-jobs/job-failures.js';

/**
 * Feature: the background clone of a connecting Repository, run by the Repository's job
 * (`repository-jobs`, which owns the queue and calls this for a `connecting` Repository).
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
    private readonly deployKeys: DeployKeyHandler,
  ) {}

  /** Runs one clone. Aborts propagate, so the queue reports them through `onFailed`. */
  async process(projectId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const repository = await this.projects.findRepository(projectId);
    // A job left over from before a restart, whose attempt reconciliation already failed.
    if (repository?.state !== 'connecting') return;
    const { url, integrationBranch } = repository;
    try {
      const ssh = await this.deployKeys.credentials(repository);
      // Retry and every first clone start clean: a partial or stale Clone is removed first.
      await this.git.removeClone(projectId, { signal });
      const remote = await this.git.inspectRemote(url, integrationBranch, { signal, ssh });
      if (!remote.branchExists) {
        await this.projects.markFailed(
          projectId,
          repositoryFailure(
            'branch_not_found',
            `Branch "${integrationBranch}" was not found on the remote.`,
            remote.defaultBranch,
          ),
        );
        return;
      }
      const { commit } = await this.git.clone(projectId, url, integrationBranch, { signal, ssh });
      signal.throwIfAborted();
      await this.projects.markReady(projectId, { headSha: commit, fetchedAt: new Date() });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      const failure = gitStepFailure(error);
      if (failure) {
        await this.projects.markFailed(projectId, failure);
        return;
      }
      // Unexpected (a rejected request, the database): `onFailed` stores `unknown`.
      throw error;
    }
  }

  async onFailed(projectId: string, failure: JobFailure): Promise<void> {
    if (failure.reason === 'error') {
      this.logger.error(
        `Clone of project ${projectId} failed unexpectedly: ${redactSecrets(String(failure.error))}`,
      );
    }
    await this.projects.markFailed(projectId, unfinishedJobFailure('clone', failure));
  }

  /** Idempotent: failing what is already failed changes nothing. */
  async reconcile(): Promise<void> {
    const failed = await this.projects.failAllConnecting(
      repositoryFailure('unknown', INTERRUPTED_DETAIL),
    );
    if (failed > 0) {
      this.logger.warn(`Marked ${failed} interrupted repository connection(s) as failed.`);
    }
  }
}
