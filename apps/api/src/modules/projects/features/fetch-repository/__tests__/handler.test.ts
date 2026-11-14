import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JobAlreadyActiveError,
  QueueUnavailableError,
} from '../../../../../platform/queue/job-queue.js';
import {
  NoRepositoryError,
  NoUsableCloneError,
  ProjectNotFoundError,
  RepositoryBusyError,
} from '../../../domain/repositories/project-repository.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { GitUnsupportedPlatformError } from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { RecordingRepositoryJobs } from '../../../ports/__tests__/recording-repository-jobs.js';
import { FetchRepositoryHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const URL = 'https://github.com/acme/shop.git';
const OLD = 'a'.repeat(40);
const FETCHED_AT = new Date('2026-11-13T10:00:00.000Z');
const FAILURE = {
  code: 'host_unreachable',
  detail: 'fatal: x',
  remoteDefaultBranch: null,
} as const;

describe('FetchRepositoryHandler', () => {
  let projects: InMemoryProjectRepository;
  let git: FakeRepositoryGit;
  let jobs: RecordingRepositoryJobs;
  let handler: FetchRepositoryHandler;

  const stored = () => projects.findRepository(PROJECT);

  async function connecting() {
    await projects.beginConnect({
      projectId: PROJECT,
      url: URL,
      identity: 'github.com/acme/shop',
      integrationBranch: 'dev',
    });
  }

  async function ready() {
    await connecting();
    await projects.markReady(PROJECT, { headSha: OLD, fetchedAt: FETCHED_AT });
  }

  /** `failed` after a fetch that kept the Clone. */
  async function failedFetch() {
    await ready();
    await projects.beginFetch(PROJECT);
    await projects.markFetchFailed(PROJECT, FAILURE, { cloneKept: true });
  }

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    git = new FakeRepositoryGit();
    jobs = new RecordingRepositoryJobs();
    handler = new FetchRepositoryHandler(projects, git, jobs);
  });

  it('marks a ready Repository fetching, schedules the fetch and returns at once', async () => {
    await ready();

    const repository = await handler.execute(PROJECT);

    expect(repository).toEqual({
      projectId: PROJECT,
      url: URL,
      integrationBranch: 'dev',
      state: 'fetching',
      hasClone: true,
      headSha: OLD,
      lastFetchedAt: FETCHED_AT,
      failure: null,
    });
    expect(jobs.started).toEqual([[PROJECT, 'fetch']]);
    // No Git runs in the request: the fetch happens in the background job.
    expect(git.calls).toEqual([]);
  });

  it('fetches again after a failed fetch that kept the Clone, clearing the failure', async () => {
    await failedFetch();

    const repository = await handler.execute(PROJECT);

    expect(repository).toMatchObject({ state: 'fetching', headSha: OLD, failure: null });
    expect(jobs.started).toEqual([[PROJECT, 'fetch']]);
  });

  it.each([
    ['connecting', connecting],
    [
      'fetching',
      async () => {
        await ready();
        await projects.beginFetch(PROJECT);
      },
    ],
  ])('refuses while %s with RepositoryBusyError', async (_state, arrange) => {
    await arrange();

    await expect(handler.execute(PROJECT)).rejects.toBeInstanceOf(RepositoryBusyError);
    expect(jobs.started).toEqual([]);
  });

  it('refuses a failed Repository without a usable Clone (failed connect)', async () => {
    await connecting();
    await projects.markFailed(PROJECT, FAILURE);

    await expect(handler.execute(PROJECT)).rejects.toBeInstanceOf(NoUsableCloneError);
    expect((await stored())?.state).toBe('failed');
  });

  it('refuses a project without a Repository', async () => {
    await expect(handler.execute(PROJECT)).rejects.toBeInstanceOf(NoRepositoryError);
  });

  it.each(['00000000-0000-4000-8000-000000000000', 'not-a-uuid'])(
    'refuses the unknown project %s',
    async (id) => {
      await expect(handler.execute(id)).rejects.toBeInstanceOf(ProjectNotFoundError);
    },
  );

  it('refuses on a host that is not Linux before changing anything', async () => {
    await ready();
    git.supported = false;

    await expect(handler.execute(PROJECT)).rejects.toBeInstanceOf(GitUnsupportedPlatformError);
    expect((await stored())?.state).toBe('ready');
  });

  it.each([
    ['the queue is down', new QueueUnavailableError()],
    ['a job is still active', new JobAlreadyActiveError('repository-git', `repository-${PROJECT}`)],
  ])('restores a ready Repository when %s, and rethrows', async (_case, error) => {
    await ready();
    jobs.failWith = error;

    await expect(handler.execute(PROJECT)).rejects.toBe(error);
    expect(await stored()).toMatchObject({
      state: 'ready',
      hasClone: true,
      headSha: OLD,
      lastFetchedAt: FETCHED_AT,
      failure: null,
    });
  });

  it('never leaves the Repository fetching when the read before the transition was stale', async () => {
    await ready();
    // The read sees the Repository as it was a moment earlier (still connecting).
    vi.spyOn(projects, 'findRepository').mockResolvedValueOnce({
      projectId: PROJECT,
      url: URL,
      integrationBranch: 'dev',
      state: 'connecting',
      hasClone: false,
      headSha: null,
      lastFetchedAt: null,
      failure: null,
    });
    const error = new JobAlreadyActiveError('repository-git', `repository-${PROJECT}`);
    jobs.failWith = error;

    await expect(handler.execute(PROJECT)).rejects.toBe(error);
    expect(await stored()).toMatchObject({
      state: 'ready',
      hasClone: true,
      headSha: OLD,
      lastFetchedAt: FETCHED_AT,
      failure: null,
    });
  });

  it('restores a failed Repository with its failure when the fetch cannot be scheduled', async () => {
    await failedFetch();
    const error = new QueueUnavailableError();
    jobs.failWith = error;

    await expect(handler.execute(PROJECT)).rejects.toBe(error);
    expect(await stored()).toMatchObject({
      state: 'failed',
      hasClone: true,
      headSha: OLD,
      failure: FAILURE,
    });
  });
});
