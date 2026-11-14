import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  type JobFailure,
  type JobQueue,
  JobQueues,
  type RunningJob,
} from '../../../../platform/queue/job-queue.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';
import type { RepositoryJobs, RepositoryOperation } from '../../ports/repository-jobs.js';
import { CloneRepositoryHandler } from '../clone-repository/handler.js';
import { RefreshCloneHandler } from '../refresh-clone/handler.js';

/** The one queue of background Git operations on Repositories (platform/queue). */
export const REPOSITORY_QUEUE = 'repository-git';

/**
 * Backstop time limit of a clone job. The Git adapter stops a clone after 10 minutes itself;
 * the job also inspects the remote and removes a leftover Clone first.
 */
export const CLONE_JOB_TIMEOUT_MS = 15 * 60 * 1000;

/** Backstop time limit of a fetch job; the Git adapter stops a fetch after 2 minutes itself. */
export const FETCH_JOB_TIMEOUT_MS = 5 * 60 * 1000;

const TIMEOUT_MS: Record<RepositoryOperation, number> = {
  clone: CLONE_JOB_TIMEOUT_MS,
  fetch: FETCH_JOB_TIMEOUT_MS,
};

/** Operations of different projects run in parallel up to this; one project's never overlap. */
export const REPOSITORY_JOB_CONCURRENCY = 2;

/** The job payload: identifiers only (#60 clarification 2, #61 clarification 8). */
type RepositoryJobPayload = { projectId: string };

/**
 * The job id of a project's Repository operation: deterministic and shared by clones and
 * fetches, so a second operation is refused while one is waiting or running.
 */
export function repositoryJobId(projectId: string): string {
  return `repository-${projectId}`;
}

/**
 * Feature: the Repository's background job (the {@link RepositoryJobs} port). It owns the
 * queue, and the Repository's state says which operation a job runs: `connecting` runs the
 * clone (`clone-repository`), `fetching` runs the fetch (`refresh-clone`).
 *
 * Registers its queue during module initialisation; the platform reconciles and starts the
 * worker only after the application has bootstrapped, so after the Git adapter's start-up
 * sweep (`onModuleInit`), which must finish before any Git job (#60 clarification 11).
 * Reconciliation fails every Repository still `connecting` or `fetching`.
 */
@Injectable()
export class RepositoryJobsHandler implements RepositoryJobs, OnModuleInit {
  private queue?: JobQueue<RepositoryJobPayload>;

  constructor(
    private readonly queues: JobQueues,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    private readonly clone: CloneRepositoryHandler,
    private readonly refresh: RefreshCloneHandler,
  ) {}

  onModuleInit(): void {
    this.queue = this.queues.register<RepositoryJobPayload>({
      name: REPOSITORY_QUEUE,
      timeoutMs: CLONE_JOB_TIMEOUT_MS,
      concurrency: REPOSITORY_JOB_CONCURRENCY,
      process: (job) => this.process(job),
      onFailed: (job, failure) => this.onFailed(job.payload.projectId, failure),
      reconcile: () => this.reconcile(),
    });
  }

  async start(projectId: string, operation: RepositoryOperation): Promise<void> {
    if (!this.queue) throw new Error('The repository queue is not registered yet.');
    await this.queue.enqueue(
      repositoryJobId(projectId),
      { projectId },
      { timeoutMs: TIMEOUT_MS[operation] },
    );
  }

  private async process({
    payload: { projectId },
    signal,
  }: RunningJob<RepositoryJobPayload>): Promise<void> {
    signal.throwIfAborted();
    const repository = await this.projects.findRepository(projectId);
    if (repository?.state === 'connecting') return this.clone.process(projectId, signal);
    if (repository?.state === 'fetching') return this.refresh.process(projectId, signal);
    // Otherwise a job left over from before a restart, whose attempt reconciliation failed.
  }

  private async onFailed(projectId: string, failure: JobFailure): Promise<void> {
    const repository = await this.projects.findRepository(projectId);
    if (repository?.state === 'connecting') return this.clone.onFailed(projectId, failure);
    if (repository?.state === 'fetching') return this.refresh.onFailed(projectId, failure);
  }

  private async reconcile(): Promise<void> {
    await this.clone.reconcile();
    await this.refresh.reconcile();
  }
}
