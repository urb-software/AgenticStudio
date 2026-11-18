import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type JobPayload,
  type JobQueue,
  JobQueues,
  type QueueDefinition,
} from '../../../../../platform/queue/job-queue.js';
import {
  CANCEL_SETTLE_TIMEOUT_MS,
  CLONE_JOB_TIMEOUT_MS,
  FETCH_JOB_TIMEOUT_MS,
  QueueRepositoryJobs,
  REPOSITORY_JOB_CONCURRENCY,
  REPOSITORY_QUEUE,
  type RepositoryJobEvents,
} from '../queue-repository-jobs.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';

class RecordingJobQueues extends JobQueues {
  definition: QueueDefinition<JobPayload> | undefined;
  readonly enqueued: { id: string; payload: JobPayload; timeoutMs?: number }[] = [];
  readonly cancelled: { id: string; settleTimeoutMs?: number }[] = [];

  register<P extends JobPayload>(definition: QueueDefinition<P>): JobQueue<P> {
    this.definition = definition as unknown as QueueDefinition<JobPayload>;
    return {
      enqueue: (id, payload, options) => {
        this.enqueued.push({ id, payload, ...options });
        return Promise.resolve();
      },
      cancel: (id, options) => {
        this.cancelled.push({ id, ...options });
        return Promise.resolve(true);
      },
    };
  }
}

describe('QueueRepositoryJobs', () => {
  let queues: RecordingJobQueues;
  let events: { [K in keyof RepositoryJobEvents]: ReturnType<typeof vi.fn> };
  let jobs: QueueRepositoryJobs;

  const job = { id: `repository-${PROJECT}`, payload: { projectId: PROJECT } };

  beforeEach(() => {
    queues = new RecordingJobQueues();
    events = {
      process: vi.fn().mockResolvedValue(undefined),
      onFailed: vi.fn().mockResolvedValue(undefined),
      reconcile: vi.fn().mockResolvedValue(undefined),
    };
    jobs = new QueueRepositoryJobs(queues);
    jobs.deliverTo(events as unknown as RepositoryJobEvents);
    jobs.onModuleInit();
  });

  it('registers one queue for clones and fetches: name, backstop time limit, concurrency', () => {
    expect(queues.definition).toMatchObject({
      name: REPOSITORY_QUEUE,
      timeoutMs: CLONE_JOB_TIMEOUT_MS,
      concurrency: REPOSITORY_JOB_CONCURRENCY,
    });
    expect(REPOSITORY_QUEUE).toBe('repository-git');
  });

  it('schedules clones and fetches under the same per-Repository id, with the project id only', async () => {
    await jobs.start(PROJECT, 'clone');
    await jobs.start(PROJECT, 'fetch');

    expect(queues.enqueued).toEqual([
      { ...job, timeoutMs: CLONE_JOB_TIMEOUT_MS },
      { ...job, timeoutMs: FETCH_JOB_TIMEOUT_MS },
    ]);
  });

  it('gives a fetch a backstop above the adapter’s 2-minute limit and below the clone’s', () => {
    expect(FETCH_JOB_TIMEOUT_MS).toBeGreaterThan(2 * 60 * 1000);
    expect(FETCH_JOB_TIMEOUT_MS).toBeLessThan(CLONE_JOB_TIMEOUT_MS);
  });

  it('cancels the Repository’s job by its shared id and waits for it to settle', async () => {
    await jobs.cancel(PROJECT);

    expect(queues.cancelled).toEqual([
      { id: `repository-${PROJECT}`, settleTimeoutMs: CANCEL_SETTLE_TIMEOUT_MS },
    ]);
  });

  it('delivers a job, its failure and the start-up reconciliation to the processor', async () => {
    const signal = new AbortController().signal;

    await queues.definition!.process({ ...job, signal });
    await queues.definition!.onFailed(job, { reason: 'timeout' });
    await queues.definition!.reconcile([job]);

    expect(events.process).toHaveBeenCalledWith(PROJECT, signal);
    expect(events.onFailed).toHaveBeenCalledWith(PROJECT, { reason: 'timeout' });
    expect(events.reconcile).toHaveBeenCalledOnce();
  });

  it('refuses to schedule or cancel before its queue is registered', async () => {
    const early = new QueueRepositoryJobs(queues);

    await expect(early.start(PROJECT, 'clone')).rejects.toThrow(/not registered/);
    await expect(early.cancel(PROJECT)).rejects.toThrow(/not registered/);
  });
});
