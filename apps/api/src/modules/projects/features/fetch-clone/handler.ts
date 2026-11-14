import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import type { JobFailure } from '../../../../platform/queue/job-queue.js';
import {
  gitOperationFailure,
  INTERRUPTED_DETAIL,
  type RepositoryFailure,
  repositoryFailure,
} from '../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';
import {
  GitCloneMissingError,
  GitOperationError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';
import {
  DeployKeyHandler,
  NO_TRUSTED_HOST_KEY_DETAIL,
  NoTrustedHostKeyError,
} from '../deploy-key/handler.js';

/** Stored when the Clone the Repository records is missing on disk. */
export const CLONE_MISSING_DETAIL =
  "Studio's clone of the repository is missing. Retry to clone it again.";

/** The failure stored for a fetch job that did not finish on its own; the Clone is kept. */
function failureOf(failure: JobFailure): RepositoryFailure {
  switch (failure.reason) {
    case 'timeout':
      return repositoryFailure('timeout', 'The fetch took too long and was stopped.');
    case 'cancelled':
      return repositoryFailure('unknown', 'Cancelled');
    // A crash-like end: the queue lost the job, or the API is shutting down.
    case 'stalled':
    case 'shutdown':
      return repositoryFailure('unknown', INTERRUPTED_DETAIL);
    case 'error':
      return repositoryFailure('unknown');
  }
}

/**
 * Feature: the background fetch of a `fetching` Repository, run by the Repository's job
 * (`repository-jobs`, which owns the queue and calls this for a `fetching` Repository).
 *
 * - Fetches the Integration branch into the existing Clone (the Git adapter's 2-minute limit
 *   and size limit apply), then marks the Repository `ready` with the branch's commit and a
 *   new fetch time, or `failed`. Every write is conditional on the Repository still being
 *   `fetching`.
 * - A failed fetch keeps the Clone and its previous commit and fetch time, except
 *   `size_limit`: the adapter then removes the Clone, so the Repository has no usable Clone
 *   and only a Retry (connect) repairs it (Issue #61 clarification 2). The same holds when the
 *   Clone turns out to be missing on disk.
 * - An SSH Repository (Issue #62) fetches with its Deploy key and only its trusted host keys
 *   (configured or pinned): a host presenting another key fails with `host_key_mismatch`,
 *   never accepted automatically; with no key trusted any more, it fails the same way.
 * - `reconcile` (start-up, before the worker) fails every Repository still `fetching` as
 *   "Interrupted"; its Clone stays usable (a killed fetch leaves the refs unchanged).
 */
@Injectable()
export class FetchCloneHandler {
  private readonly logger = new Logger('FetchClone');

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    private readonly deployKeys: DeployKeyHandler,
  ) {}

  /** Runs one fetch. Aborts propagate, so the queue reports them through `onFailed`. */
  async process(projectId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const repository = await this.projects.findRepository(projectId);
    // A job left over from before a restart, whose fetch reconciliation already failed.
    if (repository?.state !== 'fetching') return;
    const { url, integrationBranch } = repository;
    try {
      const ssh = await this.deployKeys.credentials(repository);
      const { commit } = await this.git.fetch(projectId, url, integrationBranch, { signal, ssh });
      signal.throwIfAborted();
      await this.projects.markFetched(projectId, { headSha: commit, fetchedAt: new Date() });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      if (error instanceof NoTrustedHostKeyError) {
        await this.projects.markFetchFailed(
          projectId,
          repositoryFailure('host_key_mismatch', NO_TRUSTED_HOST_KEY_DETAIL),
          { cloneKept: true },
        );
        return;
      }
      if (error instanceof GitOperationError) {
        // The Git failure reasons are the Repository failure codes (pinned by a contract test).
        const failure =
          error.reason === 'branch_not_found'
            ? repositoryFailure(
                'branch_not_found',
                `Branch "${integrationBranch}" was not found on the remote.`,
              )
            : gitOperationFailure(error.reason, error.detail);
        await this.projects.markFetchFailed(projectId, failure, {
          cloneKept: error.reason !== 'size_limit',
        });
        return;
      }
      if (error instanceof GitCloneMissingError) {
        // The database said there was a Clone, but it is gone from disk: record that there is
        // no usable Clone, so the card offers Retry instead of a Fetch that always fails.
        await this.projects.markFetchFailed(
          projectId,
          repositoryFailure('unknown', CLONE_MISSING_DETAIL),
          { cloneKept: false },
        );
        return;
      }
      // Unexpected (a rejected request, the database): `onFailed` stores `unknown`.
      throw error;
    }
  }

  async onFailed(projectId: string, failure: JobFailure): Promise<void> {
    if (failure.reason === 'error') {
      this.logger.error(
        `Fetch of project ${projectId} failed unexpectedly: ${redactSecrets(String(failure.error))}`,
      );
    }
    await this.projects.markFetchFailed(projectId, failureOf(failure), { cloneKept: true });
  }

  /** Idempotent: failing what is already failed changes nothing. */
  async reconcile(): Promise<void> {
    const failed = await this.projects.failAllFetching(
      repositoryFailure('unknown', INTERRUPTED_DETAIL),
    );
    if (failed > 0) {
      this.logger.warn(`Marked ${failed} interrupted repository fetch(es) as failed.`);
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
