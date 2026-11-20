import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { GitOperationError } from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { InMemoryDeployKeys } from '../../../ports/__tests__/in-memory-deploy-keys.js';
import { InMemorySecretStore } from '../../../ports/__tests__/in-memory-secret-store.js';
import { RepositoryCleanup } from '../../../repository-cleanup.js';
import { ResumeDisconnectsHandler } from '../handler.js';

const A = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const C = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';

describe('ResumeDisconnectsHandler', () => {
  let connections: InMemoryRepositoryConnectionRepository;
  let git: FakeRepositoryGit;
  let logs: string[];
  let handler: ResumeDisconnectsHandler;

  async function connect(projectId: string, name: string) {
    await connections.connect({
      projectId,
      url: `https://github.com/acme/${name}.git`,
      identity: `github.com/acme/${name}`,
      integrationBranch: 'dev',
    });
  }

  async function disconnecting(projectId: string, name: string) {
    await connect(projectId, name);
    await connections.change(projectId, (r) => {
      r.startDisconnect();
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    connections = new InMemoryRepositoryConnectionRepository();
    git = new FakeRepositoryGit();
    logs = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    const cleanup = new RepositoryCleanup(
      connections,
      git,
      new InMemoryDeployKeys(new InMemorySecretStore()),
    );
    handler = new ResumeDisconnectsHandler(connections, cleanup);
  });

  it('resumes every disconnecting Repository at start-up and leaves the others alone', async () => {
    await disconnecting(A, 'a');
    await connect(B, 'b');
    await disconnecting(C, 'c');

    await handler.execute();

    expect(await connections.find(A)).toBeNull();
    expect(await connections.find(C)).toBeNull();
    expect((await connections.find(B))?.state).toBe('connecting');
    expect(git.removeClone.mock.calls.map(([projectId]) => projectId).sort()).toEqual(
      [A, C].sort(),
    );
  });

  it('keeps a Repository whose Clone cannot be removed disconnecting, logs it and goes on', async () => {
    await disconnecting(A, 'a');
    await disconnecting(B, 'b');
    git.removeClone.mockImplementation((projectId) =>
      projectId === A
        ? Promise.reject(new GitOperationError('unknown', 'EBUSY'))
        : Promise.resolve(),
    );

    await handler.execute();

    expect((await connections.find(A))?.state).toBe('disconnecting');
    expect(await connections.find(B)).toBeNull();
    expect(logs).toEqual([expect.stringContaining(A)]);
  });

  it('keeps going when the store fails for one Repository', async () => {
    await disconnecting(A, 'a');
    await disconnecting(B, 'b');
    const change = connections.change.bind(connections);
    connections.change = (projectId, mutate) =>
      change(projectId, (repository) => {
        mutate(repository);
        if (projectId === A && repository.pendingChanges().removed) {
          throw new Error('database down');
        }
      });

    await handler.execute();

    expect((await connections.find(A))?.state).toBe('disconnecting');
    expect(await connections.find(B)).toBeNull();
    expect(logs).toEqual([expect.stringContaining(A)]);
  });
});
