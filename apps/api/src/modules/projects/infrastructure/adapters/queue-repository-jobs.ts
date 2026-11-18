import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type JobQueue, JobQueues } from '../../../../platform/queue/job-queue.js';
import type { UnfinishedJob } from '../../domain/value-objects/unfinished-job.js';
import type {
  RepositoryJobs,
  RepositoryOperation,
} from '../../application/ports/repository-jobs.js';

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

/**
 * How long a disconnect waits for a cancelled operation to stop. The Git adapter kills an
 * aborted Git process tree at once, so this only bounds a stuck processor.
 */
export const CANCEL_SETTLE_TIMEOUT_MS = 10_000;

/** Operations of different projects run in parallel up to this; one project's never overlap. */
export const REPOSITORY_JOB_CONCURRENCY = 2;

type RepositoryJobPayload = { projectId: string };

/**
 * The job id of a project's Repository operation: deterministic and shared by clones and
 * fetches, so a second operation is refused while one is waiting or running.
 */
export function repositoryJobId(projectId: string): string {
  return `repository-${projectId}`;
}

/**
 * Where the adapter delivers the queue's events: the module's job processor (an entry point,
 * which this layer cannot import). It receives the project id the job carries.
 */
export interface RepositoryJobEvents {
  process(projectId: string, signal: AbortSignal): Promise<void>;
  onFailed(projectId: string, failure: UnfinishedJob): Promise<void>;
  reconcile(): Promise<void>;
}

/**
 * The {@link RepositoryJobs} port over the platform queue; it owns the queue's name, limits and
 * job id. The platform starts the worker after bootstrap, so after the Git adapter's start-up
 * sweep. Events arrive through {@link deliverTo}, not injection: the handlers depend on this adapter.
 */
@Injectable()
export class QueueRepositoryJobs implements RepositoryJobs, OnModuleInit {
  private queue?: JobQueue<RepositoryJobPayload>;
  private events?: RepositoryJobEvents;

  constructor(private readonly queues: JobQueues) {}

  deliverTo(events: RepositoryJobEvents): void {
    this.events = events;
  }

  onModuleInit(): void {
    this.queue = this.queues.register<RepositoryJobPayload>({
      name: REPOSITORY_QUEUE,
      timeoutMs: CLONE_JOB_TIMEOUT_MS,
      concurrency: REPOSITORY_JOB_CONCURRENCY,
      process: ({ payload: { projectId }, signal }) =>
        this.deliveredTo().process(projectId, signal),
      onFailed: (job, failure) => this.deliveredTo().onFailed(job.payload.projectId, failure),
      reconcile: () => this.deliveredTo().reconcile(),
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

  async cancel(projectId: string): Promise<void> {
    if (!this.queue) throw new Error('The repository queue is not registered yet.');
    await this.queue.cancel(repositoryJobId(projectId), {
      settleTimeoutMs: CANCEL_SETTLE_TIMEOUT_MS,
    });
  }

  private deliveredTo(): RepositoryJobEvents {
    if (!this.events) throw new Error('The repository queue has no processor yet.');
    return this.events;
  }
}
