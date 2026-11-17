import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { FakeRepositoryGit } from '../../../application/ports/__tests__/fake-repository-git.js';
import { InMemoryDeployKeys } from '../../../application/ports/__tests__/in-memory-deploy-keys.js';
import { InMemorySecretStore } from '../../../application/ports/__tests__/in-memory-secret-store.js';
import { CloneRepositoryHandler } from '../../../application/features/clone-repository/handler.js';
import { FetchCloneHandler } from '../../../application/features/fetch-clone/handler.js';
import { GetRepositoryOperationHandler } from '../../../application/features/get-repository-operation/handler.js';
import type { RepositoryStartupRecovery } from '../../startup/repository-startup-recovery.js';
import { RepositoryJobProcessor } from '../repository-job-processor.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const COMMIT = 'a'.repeat(40);

describe('RepositoryJobProcessor', () => {
  let projects: InMemoryProjectRepository;
  let clone: CloneRepositoryHandler;
  let fetchClone: FetchCloneHandler;
  let recovery: { run: ReturnType<typeof vi.fn> };
  let processor: RepositoryJobProcessor;

  const running = () => ({ signal: new AbortController().signal });

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
    const deployKeys = new InMemoryDeployKeys(new InMemorySecretStore());
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    const git = new FakeRepositoryGit();
    clone = new CloneRepositoryHandler(projects, git, deployKeys);
    fetchClone = new FetchCloneHandler(projects, git, deployKeys);
    for (const target of [clone, fetchClone]) {
      vi.spyOn(target, 'process').mockResolvedValue();
      vi.spyOn(target, 'onFailed');
    }
    recovery = { run: vi.fn().mockResolvedValue(undefined) };
    processor = new RepositoryJobProcessor(
      new GetRepositoryOperationHandler(projects),
      clone,
      fetchClone,
      recovery as unknown as RepositoryStartupRecovery,
    );
  });

  it('runs a clone for a connecting Repository', async () => {
    await connecting();
    const current = running();

    await processor.process(PROJECT, current.signal);

    expect(clone.process).toHaveBeenCalledWith(PROJECT, current.signal);
    expect(fetchClone.process).not.toHaveBeenCalled();
  });

  it('runs a fetch for a fetching Repository', async () => {
    await fetching();
    const current = running();

    await processor.process(PROJECT, current.signal);

    expect(fetchClone.process).toHaveBeenCalledWith(PROJECT, current.signal);
    expect(clone.process).not.toHaveBeenCalled();
  });

  it('does nothing for a Repository that is neither connecting nor fetching', async () => {
    await connecting();
    await projects.markReady(PROJECT, { headSha: COMMIT, fetchedAt: new Date() });

    await processor.process(PROJECT, running().signal);

    expect(clone.process).not.toHaveBeenCalled();
    expect(fetchClone.process).not.toHaveBeenCalled();
  });

  it('does not start a job whose signal is already aborted', async () => {
    await connecting();
    const controller = new AbortController();
    controller.abort();

    await expect(processor.process(PROJECT, controller.signal)).rejects.toThrow();

    expect(clone.process).not.toHaveBeenCalled();
  });

  it('reports a failure to the operation the Repository records', async () => {
    await fetching();

    await processor.onFailed(PROJECT, { reason: 'timeout' });

    expect(fetchClone.onFailed).toHaveBeenCalledWith(PROJECT, { reason: 'timeout' });
    expect(clone.onFailed).not.toHaveBeenCalled();
    expect((await projects.findRepository(PROJECT))?.failure?.code).toBe('timeout');
  });

  it('reports a clone failure to the clone', async () => {
    await connecting();

    await processor.onFailed(PROJECT, { reason: 'stalled' });

    expect(clone.onFailed).toHaveBeenCalledWith(PROJECT, { reason: 'stalled' });
    expect(fetchClone.onFailed).not.toHaveBeenCalled();
  });

  it('does nothing for a job of a disconnecting Repository: not run, no failure written', async () => {
    await fetching();
    await projects.beginDisconnect(PROJECT);

    await processor.process(PROJECT, running().signal);
    await processor.onFailed(PROJECT, { reason: 'cancelled' });

    expect(clone.process).not.toHaveBeenCalled();
    expect(fetchClone.process).not.toHaveBeenCalled();
    expect(clone.onFailed).not.toHaveBeenCalled();
    expect(fetchClone.onFailed).not.toHaveBeenCalled();
    expect((await projects.findRepository(PROJECT))?.state).toBe('disconnecting');
  });

  it('reconciles through the start-up recovery', async () => {
    await processor.reconcile();

    expect(recovery.run).toHaveBeenCalledOnce();
  });
});
