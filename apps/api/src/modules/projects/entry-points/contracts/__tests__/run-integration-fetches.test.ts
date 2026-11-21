import { beforeEach, describe, expect, it } from 'vitest';
import { FetchRepositoryHandler } from '../../../application/features/fetch-repository/handler.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { FakeRepositoryGit } from '../../../application/ports/__tests__/fake-repository-git.js';
import { RecordingRepositoryJobs } from '../../../application/ports/__tests__/recording-repository-jobs.js';
import { ProjectRunIntegrationFetches } from '../run-integration-fetches.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const HEAD = 'a'.repeat(40);
const FETCHED_AT = new Date('2026-11-13T10:00:00.000Z');

describe('ProjectRunIntegrationFetches', () => {
  let connections: InMemoryRepositoryConnectionRepository;
  let jobs: RecordingRepositoryJobs;
  let fetches: ProjectRunIntegrationFetches;

  beforeEach(async () => {
    const projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
    projects.addProject(PROJECT, 'Shop');
    jobs = new RecordingRepositoryJobs();
    fetches = new ProjectRunIntegrationFetches(
      new FetchRepositoryHandler(projects, connections, new FakeRepositoryGit(), jobs),
    );
    await connections.connect({
      projectId: PROJECT,
      url: 'https://github.com/acme/shop.git',
      identity: 'github.com/acme/shop',
      integrationBranch: 'dev',
    });
    await connections.change(PROJECT, (r) => {
      r.completeClone({ headSha: HEAD, fetchedAt: FETCHED_AT });
    });
  });

  it('starts the Repository fetch, which keeps the Repository record as the source of truth', async () => {
    expect(await fetches.fetchIntegrationBranch(PROJECT)).toEqual({ status: 'started' });

    expect(jobs.started).toEqual([[PROJECT, 'fetch']]);
    expect(await connections.find(PROJECT)).toMatchObject({ state: 'fetching', headSha: HEAD });
  });

  it('answers not_started instead of throwing when the fetch cannot be scheduled', async () => {
    jobs.failWith = new Error('queue down');

    expect(await fetches.fetchIntegrationBranch(PROJECT)).toEqual({ status: 'not_started' });
    expect(await connections.find(PROJECT)).toMatchObject({ state: 'ready', headSha: HEAD });
  });

  it('answers not_started for a project that is unknown, has no Repository, or is already fetching', async () => {
    expect(await fetches.fetchIntegrationBranch('not-a-project')).toEqual({
      status: 'not_started',
    });
    await fetches.fetchIntegrationBranch(PROJECT);
    expect(await fetches.fetchIntegrationBranch(PROJECT)).toEqual({ status: 'not_started' });
  });
});
