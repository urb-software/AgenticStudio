import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import {
  gitOperationFailure,
  interruptedFailure,
  NO_TRUSTED_HOST_KEY_DETAIL,
  NoTrustedHostKeyError,
  type RepositoryFailure,
  repositoryFailure,
  type UnfinishedJob,
  unfinishedJobFailure,
} from '../../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  GitCloneMissingError,
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
    return repositoryFailure('host_key_mismatch', NO_TRUSTED_HOST_KEY_DETAIL);
  }
  if (error instanceof GitOperationError) return gitOperationFailure(error.reason, error.detail);
  return undefined;
}

/** Stored when the Clone the Repository records is missing on disk. */
export const CLONE_MISSING_DETAIL =
  "Studio's clone of the repository is missing. Retry to clone it again.";

/**
 * Feature: the background fetch of a `fetching` Repository, run by the Repository's job
 * (the job processor under `entry-points/jobs/` calls this for a `fetching` Repository).
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
 *   `interrupted`; its Clone stays usable (a killed fetch leaves the refs unchanged).
 */
@Injectable()
export class FetchCloneHandler {
  private readonly logger = new Logger('FetchClone');

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(DEPLOY_KEYS) private readonly deployKeys: DeployKeys,
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
      const failure = gitStepFailure(error);
      if (failure) {
        // `size_limit`: the adapter removed the Clone (Issue #61 clarification 2).
        await this.projects.markFetchFailed(projectId, failure, {
          cloneKept: failure.code !== 'size_limit',
        });
        return;
      }
      // Unexpected (a rejected request, the database): `onFailed` stores `unknown`.
      throw error;
    }
  }

  async onFailed(projectId: string, failure: UnfinishedJob): Promise<void> {
    if (failure.reason === 'error') {
      this.logger.error(
        `Fetch of project ${projectId} failed unexpectedly: ${redactSecrets(String(failure.error))}`,
      );
    }
    await this.projects.markFetchFailed(projectId, unfinishedJobFailure('fetch', failure), {
      cloneKept: true,
    });
  }

  /** Idempotent: failing what is already failed changes nothing. */
  async reconcile(): Promise<void> {
    const failed = await this.projects.failAllFetching(interruptedFailure());
    if (failed > 0) {
      this.logger.warn(`Marked ${failed} interrupted repository fetch(es) as failed.`);
    }
  }
}
