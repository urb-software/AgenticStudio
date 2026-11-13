import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import {
  type JobFailure,
  type JobQueue,
  JobQueues,
  type RunningJob,
} from '../../../../platform/queue/job-queue.js';
import {
  INTERRUPTED_DETAIL,
  type RepositoryFailure,
  type RepositoryFailureCode,
  repositoryFailure,
} from '../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';
import type { CloneJobs } from '../../ports/clone-jobs.js';
import {
  type GitFailureReason,
  GitOperationError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';

/** The queue of first clones (platform/queue). */
export const CLONE_QUEUE = 'repository-clone';

/**
 * Backstop time limit of a clone job. The Git adapter stops a clone after 10 minutes itself;
 * the job also inspects the remote and removes a leftover Clone first.
 */
export const CLONE_JOB_TIMEOUT_MS = 15 * 60 * 1000;

/** Clones of different projects run in parallel up to this; one project's never overlap. */
export const CLONE_CONCURRENCY = 2;

/** The job payload: identifiers only (Issue #60 clarification 2). */
type CloneJobPayload = { projectId: string };

/** Every Git failure reason is a Repository failure code (both are Epic #55's fixed list). */
const FAILURE_CODE: Record<GitFailureReason, RepositoryFailureCode> = {
  auth_failed: 'auth_failed',
  host_unreachable: 'host_unreachable',
  host_key_mismatch: 'host_key_mismatch',
  repository_not_found: 'repository_not_found',
  branch_not_found: 'branch_not_found',
  timeout: 'timeout',
  size_limit: 'size_limit',
  unknown: 'unknown',
};

/** The job id of a project's clone: deterministic, so a second one is refused while it runs. */
export function cloneJobId(projectId: string): string {
  return `clone-${projectId}`;
}

/** The failure stored for a job that did not finish on its own. */
function failureOf(failure: JobFailure): RepositoryFailure {
  switch (failure.reason) {
    case 'timeout':
      return repositoryFailure('timeout', 'The clone took too long and was stopped.');
    case 'cancelled':
      return repositoryFailure('unknown', 'Cancelled');
    // A crash-like end: the queue lost the job, or the API is shutting down (clarification 2).
    case 'stalled':
    case 'shutdown':
      return repositoryFailure('unknown', INTERRUPTED_DETAIL);
    case 'error':
      return repositoryFailure('unknown');
  }
}

/**
 * Feature: the background clone of a connecting Repository (the {@link CloneJobs} port).
 *
 * - Registers its queue during module initialisation; the platform starts the worker only
 *   after the application has bootstrapped, so after the Git adapter's start-up sweep
 *   (`onModuleInit`), which must finish before any Git job (clarification 11).
 * - `reconcile` (start-up, before the worker) fails every Repository still `connecting`:
 *   those whose job was interrupted and those whose job never ran (clarification 4).
 * - A job removes any leftover Clone, inspects the remote (so `branch_not_found` can name the
 *   remote's default branch), clones, then marks the Repository `ready` or `failed`. Every
 *   write is conditional on the Repository still being `connecting`.
 */
@Injectable()
export class CloneRepositoryHandler implements CloneJobs, OnModuleInit {
  private readonly logger = new Logger('CloneRepository');
  private queue?: JobQueue<CloneJobPayload>;

  constructor(
    private readonly queues: JobQueues,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
  ) {}

  onModuleInit(): void {
    this.queue = this.queues.register<CloneJobPayload>({
      name: CLONE_QUEUE,
      timeoutMs: CLONE_JOB_TIMEOUT_MS,
      concurrency: CLONE_CONCURRENCY,
      process: (job) => this.process(job),
      onFailed: (job, failure) => this.onFailed(job.payload.projectId, failure),
      reconcile: () => this.reconcile(),
    });
  }

  async start(projectId: string): Promise<void> {
    if (!this.queue) throw new Error('The clone queue is not registered yet.');
    await this.queue.enqueue(cloneJobId(projectId), { projectId });
  }

  /** Runs one clone. Aborts propagate, so the queue reports them through `onFailed`. */
  async process({ payload: { projectId }, signal }: RunningJob<CloneJobPayload>): Promise<void> {
    signal.throwIfAborted();
    const repository = await this.projects.findRepository(projectId);
    // A job left over from before a restart, whose attempt reconciliation already failed.
    if (repository?.state !== 'connecting') return;
    const { url, integrationBranch } = repository;
    try {
      // Retry and every first clone start clean: a partial or stale Clone is removed first.
      await this.git.removeClone(projectId, { signal });
      const remote = await this.git.inspectRemote(url, integrationBranch, { signal });
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
      const { commit } = await this.git.clone(projectId, url, integrationBranch, { signal });
      signal.throwIfAborted();
      await this.projects.markReady(projectId, { headSha: commit, fetchedAt: new Date() });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      if (error instanceof GitOperationError) {
        await this.projects.markFailed(
          projectId,
          repositoryFailure(FAILURE_CODE[error.reason], error.detail),
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
        `Clone of project ${projectId} failed unexpectedly: ${redactSecrets(String(failure.error))}`,
      );
    }
    await this.projects.markFailed(projectId, failureOf(failure));
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
