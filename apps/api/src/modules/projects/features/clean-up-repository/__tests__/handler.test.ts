import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { GitOperationError } from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { CleanUpRepositoryHandler } from '../handler.js';

const A = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const C = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';

describe('CleanUpRepositoryHandler', () => {
  let projects: InMemoryProjectRepository;
  let git: FakeRepositoryGit;
  let logs: string[];
  let cleanup: CleanUpRepositoryHandler;

  async function connect(projectId: string, name: string) {
    projects.addProject(projectId, name);
    await projects.beginConnect({
      projectId,
      url: `https://github.com/acme/${name}.git`,
      identity: `github.com/acme/${name}`,
      integrationBranch: 'dev',
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    git = new FakeRepositoryGit();
    logs = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    cleanup = new CleanUpRepositoryHandler(projects, git);
  });

  it('resumes every disconnecting Repository at start-up and leaves the others alone', async () => {
    await connect(A, 'a');
    await connect(B, 'b');
    await connect(C, 'c');
    await projects.beginDisconnect(A);
    await projects.beginDisconnect(C);

    await cleanup.resumeAll();

    expect(await projects.findRepository(A)).toBeNull();
    expect(await projects.findRepository(C)).toBeNull();
    expect((await projects.findRepository(B))?.state).toBe('connecting');
    expect(git.removeClone.mock.calls.map(([projectId]) => projectId).sort()).toEqual(
      [A, C].sort(),
    );
  });

  it('keeps a Repository whose Clone cannot be removed disconnecting, logs it and goes on', async () => {
    await connect(A, 'a');
    await connect(B, 'b');
    await projects.beginDisconnect(A);
    await projects.beginDisconnect(B);
    git.removeClone.mockImplementation((projectId) =>
      projectId === A
        ? Promise.reject(new GitOperationError('unknown', 'EBUSY'))
        : Promise.resolve(),
    );

    await cleanup.resumeAll();

    expect((await projects.findRepository(A))?.state).toBe('disconnecting');
    expect(await projects.findRepository(B)).toBeNull();
    expect(logs).toEqual([expect.stringContaining(A)]);
  });

  it('keeps going when the store fails for one Repository', async () => {
    await connect(A, 'a');
    await connect(B, 'b');
    await projects.beginDisconnect(A);
    await projects.beginDisconnect(B);
    const deleteDisconnecting = projects.deleteDisconnecting.bind(projects);
    projects.deleteDisconnecting = (projectId) =>
      projectId === A ? Promise.reject(new Error('database down')) : deleteDisconnecting(projectId);

    await cleanup.resumeAll();

    expect((await projects.findRepository(A))?.state).toBe('disconnecting');
    expect(await projects.findRepository(B)).toBeNull();
    expect(logs).toEqual([expect.stringContaining(A)]);
  });

  it('never deletes a Repository that is not disconnecting', async () => {
    await connect(A, 'a');

    await expect(cleanup.finish(A)).resolves.toBe(false);
    expect((await projects.findRepository(A))?.state).toBe('connecting');
    expect(git.removeClone).not.toHaveBeenCalled();
  });
});
