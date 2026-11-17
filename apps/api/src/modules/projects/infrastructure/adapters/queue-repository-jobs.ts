import { Injectable, type OnModuleInit } from '@nestjs/common';
import { type JobFailure, type JobQueue, JobQueues } from '../../../../platform/queue/job-queue.js';
import type {
  RepositoryJobs,
  RepositoryOperation,
} from '../../application/ports/repository-jobs.js';

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

/**
 * How long a disconnect waits for a cancelled operation to stop (#63 clarification 1). The Git
 * adapter kills an aborted Git process tree at once, so this only bounds a stuck processor.
 */
export const CANCEL_SETTLE_TIMEOUT_MS = 10_000;

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
 * Where the adapter delivers the queue's events: the module's job processor (an entry point,
 * which this layer cannot import). It receives the project id the job carries.
 */
export interface RepositoryJobEvents {
  process(projectId: string, signal: AbortSignal): Promise<void>;
  onFailed(projectId: string, failure: JobFailure): Promise<void>;
  reconcile(): Promise<void>;
}

/**
 * The {@link RepositoryJobs} port over the platform queue. It owns the queue: its name, time
 * limits, concurrency and the deterministic job id. It registers the queue during module
 * initialisation and hands every event of a job to the {@link RepositoryJobEvents} the module
 * wiring gave it ({@link deliverTo}); the platform reconciles and starts the worker only after
 * the application has bootstrapped, so after the Git adapter's start-up sweep (`onModuleInit`),
 * which must finish before any Git job (#60 clarification 11).
 *
 * The events are delivered through a call after construction, not injected, because the
 * processor's handlers (a Disconnect cancels the job) depend on this adapter.
 */
@Injectable()
export class QueueRepositoryJobs implements RepositoryJobs, OnModuleInit {
  private queue?: JobQueue<RepositoryJobPayload>;
  private events?: RepositoryJobEvents;

  constructor(private readonly queues: JobQueues) {}

  /** Sets where the queue's events go; called by the module wiring before initialisation. */
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
