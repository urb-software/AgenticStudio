import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type JobPayload,
  type JobQueue,
  JobQueues,
  type QueueDefinition,
} from '../../../../../platform/queue/job-queue.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { CloneRepositoryHandler } from '../../clone-repository/handler.js';
import { RefreshCloneHandler } from '../../refresh-clone/handler.js';
import {
  CLONE_JOB_TIMEOUT_MS,
  FETCH_JOB_TIMEOUT_MS,
  REPOSITORY_JOB_CONCURRENCY,
  REPOSITORY_QUEUE,
  RepositoryJobsHandler,
} from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const COMMIT = 'a'.repeat(40);

/** Captures the registered definition and the enqueued jobs. */
class RecordingJobQueues extends JobQueues {
  definition: QueueDefinition<JobPayload> | undefined;
  readonly enqueued: { id: string; payload: JobPayload; timeoutMs?: number }[] = [];

  register<P extends JobPayload>(definition: QueueDefinition<P>): JobQueue<P> {
    this.definition = definition as unknown as QueueDefinition<JobPayload>;
    return {
      enqueue: (id, payload, options) => {
        this.enqueued.push({ id, payload, ...options });
        return Promise.resolve();
      },
      cancel: () => Promise.resolve(false),
    };
  }
}

describe('RepositoryJobsHandler', () => {
  let projects: InMemoryProjectRepository;
  let queues: RecordingJobQueues;
  let clone: CloneRepositoryHandler;
  let refresh: RefreshCloneHandler;
  let handler: RepositoryJobsHandler;

  const job = { id: `repository-${PROJECT}`, payload: { projectId: PROJECT } };
  const running = () => ({ ...job, signal: new AbortController().signal });

  async function connecting() {
    await projects.beginConnect({
      projectId: PROJECT,
      url: 'https://github.com/acme/shop.git',
      identity: 'github.com/acme/shop',
      integrationBranch: 'dev',
    });
  }

  async function fetching() {
    await connecting();
    await projects.markReady(PROJECT, { headSha: COMMIT, fetchedAt: new Date() });
    await projects.beginFetch(PROJECT);
  }

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    const git = new FakeRepositoryGit();
    queues = new RecordingJobQueues();
    clone = new CloneRepositoryHandler(projects, git);
    refresh = new RefreshCloneHandler(projects, git);
    for (const target of [clone, refresh]) {
      vi.spyOn(target, 'process').mockResolvedValue();
      vi.spyOn(target, 'onFailed');
      vi.spyOn(target, 'reconcile');
    }
    handler = new RepositoryJobsHandler(queues, projects, clone, refresh);
    handler.onModuleInit();
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
    await handler.start(PROJECT, 'clone');
    await handler.start(PROJECT, 'fetch');

    expect(queues.enqueued).toEqual([
      { ...job, timeoutMs: CLONE_JOB_TIMEOUT_MS },
      { ...job, timeoutMs: FETCH_JOB_TIMEOUT_MS },
    ]);
  });

  it('gives a fetch a backstop above the adapter’s 2-minute limit and below the clone’s', () => {
    expect(FETCH_JOB_TIMEOUT_MS).toBeGreaterThan(2 * 60 * 1000);
    expect(FETCH_JOB_TIMEOUT_MS).toBeLessThan(CLONE_JOB_TIMEOUT_MS);
  });

  it('runs a clone for a connecting Repository', async () => {
    await connecting();
    const current = running();

    await queues.definition!.process(current);

    expect(clone.process).toHaveBeenCalledWith(PROJECT, current.signal);
    expect(refresh.process).not.toHaveBeenCalled();
  });

  it('runs a fetch for a fetching Repository', async () => {
    await fetching();
    const current = running();

    await queues.definition!.process(current);

    expect(refresh.process).toHaveBeenCalledWith(PROJECT, current.signal);
    expect(clone.process).not.toHaveBeenCalled();
  });

  it('does nothing for a Repository that is neither connecting nor fetching', async () => {
    await connecting();
    await projects.markReady(PROJECT, { headSha: COMMIT, fetchedAt: new Date() });

    await queues.definition!.process(running());

    expect(clone.process).not.toHaveBeenCalled();
    expect(refresh.process).not.toHaveBeenCalled();
  });

  it('reports a failure to the operation the Repository records', async () => {
    await fetching();

    await queues.definition!.onFailed(job, { reason: 'timeout' });

    expect(refresh.onFailed).toHaveBeenCalledWith(PROJECT, { reason: 'timeout' });
    expect(clone.onFailed).not.toHaveBeenCalled();
    expect((await projects.findRepository(PROJECT))?.failure?.code).toBe('timeout');
  });

  it('reports a clone failure to the clone', async () => {
    await connecting();

    await queues.definition!.onFailed(job, { reason: 'stalled' });

    expect(clone.onFailed).toHaveBeenCalledWith(PROJECT, { reason: 'stalled' });
    expect(refresh.onFailed).not.toHaveBeenCalled();
  });

  it('reconciles interrupted clones and fetches', async () => {
    await queues.definition!.reconcile([job]);

    expect(clone.reconcile).toHaveBeenCalledOnce();
    expect(refresh.reconcile).toHaveBeenCalledOnce();
  });
});
