import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type JobPayload,
  type JobQueue,
  JobQueues,
  type QueueDefinition,
} from '../../../../../platform/queue/job-queue.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { CleanUpRepositoryHandler } from '../../clean-up-repository/handler.js';
import { CloneRepositoryHandler } from '../../clone-repository/handler.js';
import { FetchCloneHandler } from '../../fetch-clone/handler.js';
import {
  CANCEL_SETTLE_TIMEOUT_MS,
  CLONE_JOB_TIMEOUT_MS,
  FETCH_JOB_TIMEOUT_MS,
  REPOSITORY_JOB_CONCURRENCY,
  REPOSITORY_QUEUE,
  RepositoryJobsHandler,
} from '../handler.js';
import { DeployKeyHandler } from '../../deploy-key/handler.js';
import { InMemorySecretStore } from '../../deploy-key/__tests__/in-memory-secret-store.js';
import { SweepOrphanedDeployKeysHandler } from '../../sweep-orphaned-deploy-keys/handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const COMMIT = 'a'.repeat(40);

/** Captures the registered definition and the enqueued jobs. */
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

describe('RepositoryJobsHandler', () => {
  let secrets: InMemorySecretStore;
  let deployKeys: DeployKeyHandler;
  let projects: InMemoryProjectRepository;
  let queues: RecordingJobQueues;
  let clone: CloneRepositoryHandler;
  let fetchClone: FetchCloneHandler;
  let cleanup: CleanUpRepositoryHandler;
  let orphanedKeys: SweepOrphanedDeployKeysHandler;
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
    secrets = new InMemorySecretStore();
    deployKeys = new DeployKeyHandler(secrets, { knownHosts: [] });
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    const git = new FakeRepositoryGit();
    queues = new RecordingJobQueues();
    clone = new CloneRepositoryHandler(projects, git, deployKeys);
    fetchClone = new FetchCloneHandler(projects, git, deployKeys);
    for (const target of [clone, fetchClone]) {
      vi.spyOn(target, 'process').mockResolvedValue();
      vi.spyOn(target, 'onFailed');
      vi.spyOn(target, 'reconcile');
    }
    cleanup = new CleanUpRepositoryHandler(projects, git, deployKeys);
    vi.spyOn(cleanup, 'resumeAll');
    orphanedKeys = new SweepOrphanedDeployKeysHandler(projects, deployKeys, { gracePeriodMs: 0 });
    vi.spyOn(orphanedKeys, 'sweep');
    handler = new RepositoryJobsHandler(queues, projects, clone, fetchClone, cleanup, orphanedKeys);
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
    expect(fetchClone.process).not.toHaveBeenCalled();
  });

  it('runs a fetch for a fetching Repository', async () => {
    await fetching();
    const current = running();

    await queues.definition!.process(current);

    expect(fetchClone.process).toHaveBeenCalledWith(PROJECT, current.signal);
    expect(clone.process).not.toHaveBeenCalled();
  });

  it('does nothing for a Repository that is neither connecting nor fetching', async () => {
    await connecting();
    await projects.markReady(PROJECT, { headSha: COMMIT, fetchedAt: new Date() });

    await queues.definition!.process(running());

    expect(clone.process).not.toHaveBeenCalled();
    expect(fetchClone.process).not.toHaveBeenCalled();
  });

  it('reports a failure to the operation the Repository records', async () => {
    await fetching();

    await queues.definition!.onFailed(job, { reason: 'timeout' });

    expect(fetchClone.onFailed).toHaveBeenCalledWith(PROJECT, { reason: 'timeout' });
    expect(clone.onFailed).not.toHaveBeenCalled();
    expect((await projects.findRepository(PROJECT))?.failure?.code).toBe('timeout');
  });

  it('reports a clone failure to the clone', async () => {
    await connecting();

    await queues.definition!.onFailed(job, { reason: 'stalled' });

    expect(clone.onFailed).toHaveBeenCalledWith(PROJECT, { reason: 'stalled' });
    expect(fetchClone.onFailed).not.toHaveBeenCalled();
  });

  it('reconciles interrupted clones and fetches, resumes pending disconnects, then sweeps orphaned Deploy keys', async () => {
    await queues.definition!.reconcile([job]);

    expect(clone.reconcile).toHaveBeenCalledOnce();
    expect(fetchClone.reconcile).toHaveBeenCalledOnce();
    expect(cleanup.resumeAll).toHaveBeenCalledOnce();
    expect(orphanedKeys.sweep).toHaveBeenCalledOnce();
    expect(vi.mocked(orphanedKeys.sweep).mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(cleanup.resumeAll).mock.invocationCallOrder[0]!,
    );
  });

  it('cancels the Repository’s job by its shared id and waits for it to settle', async () => {
    await handler.cancel(PROJECT);

    expect(queues.cancelled).toEqual([
      { id: `repository-${PROJECT}`, settleTimeoutMs: CANCEL_SETTLE_TIMEOUT_MS },
    ]);
  });

  it('does nothing for a job of a disconnecting Repository: not run, no failure written', async () => {
    await fetching();
    await projects.beginDisconnect(PROJECT);

    await queues.definition!.process(running());
    await queues.definition!.onFailed(job, { reason: 'cancelled' });

    expect(clone.process).not.toHaveBeenCalled();
    expect(fetchClone.process).not.toHaveBeenCalled();
    expect(clone.onFailed).not.toHaveBeenCalled();
    expect(fetchClone.onFailed).not.toHaveBeenCalled();
    expect((await projects.findRepository(PROJECT))?.state).toBe('disconnecting');
  });
});
