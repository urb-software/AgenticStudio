import { beforeEach, describe, expect, it } from 'vitest';
import {
  JobAbortedError,
  type JobPayload,
  type JobQueue,
  JobQueues,
  type QueueDefinition,
} from '../../../../../platform/queue/job-queue.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import {
  GIT_FAILURE_REASONS,
  GitOperationError,
  GitRequestRejectedError,
} from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import {
  CLONE_CONCURRENCY,
  CLONE_JOB_TIMEOUT_MS,
  CLONE_QUEUE,
  CloneRepositoryHandler,
} from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const URL = 'https://github.com/acme/shop.git';
const COMMIT = 'b'.repeat(40);

/** Captures the registered definition and the enqueued jobs. */
class RecordingJobQueues extends JobQueues {
  definition: QueueDefinition<JobPayload> | undefined;
  readonly enqueued: { id: string; payload: JobPayload }[] = [];

  register<P extends JobPayload>(definition: QueueDefinition<P>): JobQueue<P> {
    this.definition = definition as unknown as QueueDefinition<JobPayload>;
    return {
      enqueue: (id, payload) => {
        this.enqueued.push({ id, payload });
        return Promise.resolve();
      },
      cancel: () => Promise.resolve(false),
    };
  }
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

describe('CloneRepositoryHandler', () => {
  let projects: InMemoryProjectRepository;
  let git: FakeRepositoryGit;
  let queues: RecordingJobQueues;
  let handler: CloneRepositoryHandler;

  const job = (signal = new AbortController().signal) => ({
    id: `clone-${PROJECT}`,
    payload: { projectId: PROJECT },
    signal,
  });

  async function connecting(integrationBranch = 'dev') {
    await projects.beginConnect({
      projectId: PROJECT,
      url: URL,
      identity: 'github.com/acme/shop',
      integrationBranch,
    });
  }

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    git = new FakeRepositoryGit();
    queues = new RecordingJobQueues();
    handler = new CloneRepositoryHandler(queues, projects, git);
    handler.onModuleInit();
  });

  it('registers its queue at module initialisation: name, time limit, concurrency', () => {
    expect(queues.definition).toMatchObject({
      name: CLONE_QUEUE,
      timeoutMs: CLONE_JOB_TIMEOUT_MS,
      concurrency: CLONE_CONCURRENCY,
    });
  });

  it('schedules a clone under a deterministic id with the project id as the only payload', async () => {
    await handler.start(PROJECT);

    expect(queues.enqueued).toEqual([{ id: `clone-${PROJECT}`, payload: { projectId: PROJECT } }]);
  });

  it('removes any leftover Clone, inspects the remote, clones, and marks the Repository ready', async () => {
    await connecting();
    git.clone.mockResolvedValueOnce({ commit: COMMIT });

    await handler.process(job());

    expect(git.calls).toEqual(['removeClone', 'inspectRemote', 'clone']);
    expect(git.clone).toHaveBeenCalledWith(PROJECT, URL, 'dev', expect.anything());
    expect(await projects.findRepository(PROJECT)).toMatchObject({
      state: 'ready',
      headSha: COMMIT,
      lastFetchedAt: expect.any(Date),
      failure: null,
    });
  });

  it('passes the job signal to every Git operation', async () => {
    await connecting();
    const controller = new AbortController();

    await handler.process(job(controller.signal));

    for (const operation of [git.removeClone, git.inspectRemote, git.clone]) {
      expect(operation.mock.calls[0]!.at(-1)).toEqual({ signal: controller.signal });
    }
  });

  it('fails with branch_not_found naming the remote default branch, without cloning', async () => {
    await connecting('release');
    git.inspectRemote.mockResolvedValueOnce({ defaultBranch: 'main', branchExists: false });

    await handler.process(job());

    expect(git.clone).not.toHaveBeenCalled();
    expect((await projects.findRepository(PROJECT))?.failure).toEqual({
      code: 'branch_not_found',
      detail: 'Branch "release" was not found on the remote.',
      remoteDefaultBranch: 'main',
    });
  });

  it('fails with branch_not_found and no default branch when the remote advertises none', async () => {
    await connecting('release');
    git.inspectRemote.mockResolvedValueOnce({ defaultBranch: null, branchExists: false });

    await handler.process(job());

    expect((await projects.findRepository(PROJECT))?.failure?.remoteDefaultBranch).toBeNull();
  });

  it.each(GIT_FAILURE_REASONS)(
    'stores the Git failure %s with its redacted detail',
    async (reason) => {
      await connecting();
      git.clone.mockRejectedValueOnce(new GitOperationError(reason, 'fatal: <redacted>'));

      await handler.process(job());

      expect((await projects.findRepository(PROJECT))?.failure).toEqual({
        code: reason,
        detail: 'fatal: <redacted>',
        remoteDefaultBranch: null,
      });
    },
  );

  it('cuts an over-long detail', async () => {
    await connecting();
    git.inspectRemote.mockRejectedValueOnce(new GitOperationError('unknown', 'x'.repeat(5000)));

    await handler.process(job());

    expect((await projects.findRepository(PROJECT))?.failure?.detail).toHaveLength(2000);
  });

  it('does nothing for a job whose Repository is no longer connecting', async () => {
    await connecting();
    await projects.markFailed(PROJECT, {
      code: 'unknown',
      detail: 'Interrupted',
      remoteDefaultBranch: null,
    });

    await handler.process(job());

    expect(git.calls).toEqual([]);
  });

  it('honours an abort before it starts: no Git runs', async () => {
    await connecting();
    const controller = new AbortController();
    controller.abort(new JobAbortedError('cancelled'));

    await expect(handler.process(job(controller.signal))).rejects.toBeInstanceOf(JobAbortedError);
    expect(git.calls).toEqual([]);
  });

  it('lets an abort during Git propagate and leaves the failure to onFailed', async () => {
    await connecting();
    const controller = new AbortController();
    git.clone.mockImplementationOnce(() => {
      controller.abort(new JobAbortedError('timeout'));
      return Promise.reject(abortError());
    });

    await expect(handler.process(job(controller.signal))).rejects.toThrow('aborted');
    expect((await projects.findRepository(PROJECT))?.state).toBe('connecting');

    await queues.definition!.onFailed(job(), { reason: 'timeout' });
    expect((await projects.findRepository(PROJECT))?.failure).toMatchObject({ code: 'timeout' });
  });

  it('rethrows an unexpected error, so onFailed stores unknown', async () => {
    await connecting();
    git.removeClone.mockRejectedValueOnce(new GitRequestRejectedError('unexpected'));

    await expect(handler.process(job())).rejects.toBeInstanceOf(GitRequestRejectedError);
  });

  it.each([
    ['stalled', { code: 'unknown', detail: 'Interrupted' }],
    ['shutdown', { code: 'unknown', detail: 'Interrupted' }],
    ['cancelled', { code: 'unknown', detail: 'Cancelled' }],
    ['timeout', { code: 'timeout' }],
  ] as const)('onFailed stores %s as %j', async (reason, failure) => {
    await connecting();

    await queues.definition!.onFailed(job(), { reason });

    expect((await projects.findRepository(PROJECT))?.failure).toMatchObject(failure);
  });

  it('onFailed stores an unexpected error as unknown with no detail', async () => {
    await connecting();

    await queues.definition!.onFailed(job(), { reason: 'error', error: new Error('db down') });

    expect((await projects.findRepository(PROJECT))?.failure).toEqual({
      code: 'unknown',
      detail: '',
      remoteDefaultBranch: null,
    });
  });

  it('reconcile fails every connecting Repository as Interrupted, idempotently', async () => {
    await connecting();
    const other = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    projects.addProject(other, 'Ready one');
    await projects.beginConnect({
      projectId: other,
      url: 'https://github.com/acme/ready.git',
      identity: 'github.com/acme/ready',
      integrationBranch: 'dev',
    });
    await projects.markReady(other, { headSha: COMMIT, fetchedAt: new Date() });

    await queues.definition!.reconcile([]);
    await queues.definition!.reconcile([
      { id: `clone-${PROJECT}`, payload: { projectId: PROJECT } },
    ]);

    expect((await projects.findRepository(PROJECT))?.failure).toEqual({
      code: 'unknown',
      detail: 'Interrupted',
      remoteDefaultBranch: null,
    });
    expect((await projects.findRepository(other))?.state).toBe('ready');
  });
});
