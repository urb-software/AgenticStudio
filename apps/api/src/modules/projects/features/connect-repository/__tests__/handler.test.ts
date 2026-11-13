import { beforeEach, describe, expect, it } from 'vitest';
import { JobAlreadyActiveError } from '../../../../../platform/queue/job-queue.js';
import { ProjectNotFoundError } from '../../../domain/repositories/project-repository.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InvalidIntegrationBranchError } from '../../../domain/value-objects/integration-branch.js';
import { InvalidRepositoryUrlError } from '../../../domain/value-objects/repository-url.js';
import type { CloneJobs } from '../../../ports/clone-jobs.js';
import { GitUnsupportedPlatformError } from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { ConnectRepositoryHandler, NOT_STARTED_DETAIL } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const URL = 'https://github.com/acme/shop.git';

class RecordingCloneJobs implements CloneJobs {
  readonly started: string[] = [];
  failWith: Error | undefined;

  start(projectId: string): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.started.push(projectId);
    return Promise.resolve();
  }
}

describe('ConnectRepositoryHandler', () => {
  let projects: InMemoryProjectRepository;
  let git: FakeRepositoryGit;
  let jobs: RecordingCloneJobs;

  const handler = (allowFileRemotes = false) =>
    new ConnectRepositoryHandler(projects, git, jobs, { allowFileRemotes });

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    git = new FakeRepositoryGit();
    jobs = new RecordingCloneJobs();
  });

  it('stores the Repository as connecting, schedules the clone and returns at once', async () => {
    const repository = await handler().execute({
      projectId: PROJECT,
      url: ` ${URL} `,
      integrationBranch: ' dev ',
    });

    expect(repository).toEqual({
      projectId: PROJECT,
      url: URL,
      integrationBranch: 'dev',
      state: 'connecting',
      headSha: null,
      lastFetchedAt: null,
      failure: null,
    });
    expect(projects.repositories.get(PROJECT)?.identity).toBe('github.com/acme/shop');
    expect(jobs.started).toEqual([PROJECT]);
    // No Git runs in the request: the clone happens in the background job.
    expect(git.calls).toEqual([]);
  });

  it.each([
    ['an SSH URL', 'git@github.com:acme/shop.git'],
    ['http://', 'http://github.com/acme/shop.git'],
    ['a file:// URL without the test-only setting', 'file:///srv/shop.git'],
  ])('rejects %s before storing or scheduling anything', async (_case, url) => {
    await expect(
      handler().execute({ projectId: PROJECT, url, integrationBranch: 'dev' }),
    ).rejects.toBeInstanceOf(InvalidRepositoryUrlError);

    expect(projects.repositories.size).toBe(0);
    expect(jobs.started).toEqual([]);
  });

  it('accepts a file:// URL under the test-only fixture-remote setting', async () => {
    await handler(true).execute({
      projectId: PROJECT,
      url: 'file:///srv/fixtures/shop.git',
      integrationBranch: 'dev',
    });

    expect(jobs.started).toEqual([PROJECT]);
  });

  it('rejects an invalid integration branch', async () => {
    await expect(
      handler().execute({ projectId: PROJECT, url: URL, integrationBranch: 'a..b' }),
    ).rejects.toBeInstanceOf(InvalidIntegrationBranchError);
    expect(projects.repositories.size).toBe(0);
  });

  it('refuses a valid request on an unsupported platform, storing nothing', async () => {
    git.supported = false;

    await expect(
      handler().execute({ projectId: PROJECT, url: URL, integrationBranch: 'dev' }),
    ).rejects.toBeInstanceOf(GitUnsupportedPlatformError);
    expect(projects.repositories.size).toBe(0);
    expect(jobs.started).toEqual([]);
  });

  it('reports field errors before the platform, so they show on every platform', async () => {
    git.supported = false;

    await expect(
      handler().execute({
        projectId: PROJECT,
        url: 'git@github.com:a/b',
        integrationBranch: 'dev',
      }),
    ).rejects.toBeInstanceOf(InvalidRepositoryUrlError);
  });

  it.each(['00000000-0000-4000-8000-000000000000', 'not-a-uuid'])(
    'reports the unknown project %s',
    async (projectId) => {
      await expect(
        handler().execute({ projectId, url: URL, integrationBranch: 'dev' }),
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
      expect(jobs.started).toEqual([]);
    },
  );

  it('marks the attempt failed when the clone cannot be scheduled, and rethrows', async () => {
    const busy = new JobAlreadyActiveError('repository-clone', `clone-${PROJECT}`);
    jobs.failWith = busy;

    await expect(
      handler().execute({ projectId: PROJECT, url: URL, integrationBranch: 'dev' }),
    ).rejects.toBe(busy);

    expect(await projects.findRepository(PROJECT)).toMatchObject({
      state: 'failed',
      failure: { code: 'unknown', detail: NOT_STARTED_DETAIL, remoteDefaultBranch: null },
    });
  });
});
