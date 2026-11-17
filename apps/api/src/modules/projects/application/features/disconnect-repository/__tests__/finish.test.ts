import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepositoryConnection } from '../../../../domain/entities/repository.js';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { GitOperationError } from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { RecordingRepositoryJobs } from '../../../ports/__tests__/recording-repository-jobs.js';
import { DisconnectRepositoryHandler } from '../handler.js';
import { generateDeployKey } from '../../../../domain/value-objects/ssh-key.js';
import { SecretStoreUnavailableError } from '../../../../../../platform/secrets/index.js';
import { InMemoryDeployKeys } from '../../../ports/__tests__/in-memory-deploy-keys.js';
import { InMemorySecretStore } from '../../../ports/__tests__/in-memory-secret-store.js';

const A = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const C = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';

describe('DisconnectRepositoryHandler finishing a disconnect', () => {
  let secrets: InMemorySecretStore;
  let deployKeys: InMemoryDeployKeys;
  let projects: InMemoryProjectRepository;
  let git: FakeRepositoryGit;
  let logs: string[];
  let cleanup: DisconnectRepositoryHandler;

  async function connect(projectId: string, name: string) {
    projects.addProject(projectId, name);
    await projects.connect({
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
    secrets = new InMemorySecretStore();
    deployKeys = new InMemoryDeployKeys(secrets);
    projects = new InMemoryProjectRepository();
    git = new FakeRepositoryGit();
    logs = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    cleanup = new DisconnectRepositoryHandler(
      projects,
      git,
      new RecordingRepositoryJobs(),
      deployKeys,
    );
  });

  it('resumes every disconnecting Repository at start-up and leaves the others alone', async () => {
    await connect(A, 'a');
    await connect(B, 'b');
    await connect(C, 'c');
    await projects.change(A, (r) => {
      r.startDisconnect();
    });
    await projects.change(C, (r) => {
      r.startDisconnect();
    });

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
    await projects.change(A, (r) => {
      r.startDisconnect();
    });
    await projects.change(B, (r) => {
      r.startDisconnect();
    });
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
    await projects.change(A, (r) => {
      r.startDisconnect();
    });
    await projects.change(B, (r) => {
      r.startDisconnect();
    });
    const change = projects.change.bind(projects);
    projects.change = (projectId, mutate) =>
      change(projectId, (repository) => {
        mutate(repository);
        if (projectId === A && repository.pendingChanges().removed) {
          throw new Error('database down');
        }
      });

    await cleanup.resumeAll();

    expect((await projects.findRepository(A))?.state).toBe('disconnecting');
    expect(await projects.findRepository(B)).toBeNull();
    expect(logs).toEqual([expect.stringContaining(A)]);
  });

  it.each([
    ['reading the Repository', 'findRepository'],
    ['deleting the record', 'change'],
  ] as const)(
    'reports a store failure while %s as pending (logged redacted), never as an error',
    async (_case, method) => {
      await connect(A, 'a');
      await projects.change(A, (r) => {
        r.startDisconnect();
      });
      vi.spyOn(projects, method).mockRejectedValue(
        new Error('connect ECONNREFUSED postgres://studio:hunter2@db:5432'),
      );

      await expect(cleanup.finish(A)).resolves.toBe(false);

      expect(logs).toEqual([expect.stringContaining(A)]);
      expect(logs[0]).not.toContain('hunter2');
    },
  );

  it('never deletes a Repository that is not disconnecting', async () => {
    await connect(A, 'a');

    await expect(cleanup.finish(A)).resolves.toBe(false);
    expect((await projects.findRepository(A))?.state).toBe('connecting');
    expect(git.removeClone).not.toHaveBeenCalled();
  });

  describe('an SSH Repository (Issue #62)', () => {
    async function connectOverSsh(projectId: string) {
      projects.addProject(projectId, 'ssh');
      const deployKey = await deployKeys.create('ssh');
      await projects.connect({
        projectId,
        url: 'git@git.example.com:acme/ssh.git',
        identity: 'git.example.com/acme/ssh',
        integrationBranch: 'dev',
        deployKey,
      });
      const pending = generateDeployKey('host').publicKey.split(' ').slice(0, 2).join(' ');
      await projects.change(projectId, (r) => {
        r.awaitHostKey(pending);
      });
      await projects.change(projectId, (r) => {
        r.startVerifiedClone({ pendingHostKey: pending });
      });
      return deployKey;
    }

    it('deletes the private key from the secret store and forgets the pinned host key, then the record', async () => {
      await connectOverSsh(A);
      const forget = vi.spyOn(RepositoryConnection.prototype, 'forgetDeployKey');
      await projects.change(A, (r) => {
        r.startDisconnect();
      });

      expect(await cleanup.finish(A)).toBe(true);

      expect(secrets.values.size).toBe(0);
      expect(forget).toHaveBeenCalledTimes(1);
      expect(await projects.findRepository(A)).toBeNull();
    });

    it('stays disconnecting when the secret cannot be deleted, and completes on a retry', async () => {
      await connectOverSsh(A);
      await projects.change(A, (r) => {
        r.startDisconnect();
      });
      secrets.failWith = new SecretStoreUnavailableError();

      expect(await cleanup.finish(A)).toBe(false);
      expect(await projects.findRepository(A)).toMatchObject({
        state: 'disconnecting',
        deployKeySecret: expect.any(String),
      });
      expect(logs.join('\n')).toMatch(/could not delete the Deploy key/);

      secrets.failWith = undefined;
      expect(await cleanup.finish(A)).toBe(true);
      expect(secrets.values.size).toBe(0);
    });

    it('skips the Deploy key steps for an HTTPS Repository', async () => {
      await connect(B, 'b');
      const forget = vi.spyOn(RepositoryConnection.prototype, 'forgetDeployKey');
      await projects.change(B, (r) => {
        r.startDisconnect();
      });

      expect(await cleanup.finish(B)).toBe(true);
      expect(forget).not.toHaveBeenCalled();
    });
  });
});
