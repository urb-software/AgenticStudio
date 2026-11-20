import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepositoryConnection } from '../../domain/entities/repository-connection.js';
import { InMemoryRepositoryConnectionRepository } from '../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { FakeRepositoryGit } from '../ports/__tests__/fake-repository-git.js';
import { RepositoryCleanup } from '../repository-cleanup.js';
import { testDeployKey } from '../../domain/value-objects/__tests__/test-deploy-key.js';
import { SecretStoreUnavailableError } from '../../../../platform/secrets/index.js';
import { InMemoryDeployKeys } from '../ports/__tests__/in-memory-deploy-keys.js';
import { InMemorySecretStore } from '../ports/__tests__/in-memory-secret-store.js';

const A = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('RepositoryCleanup finishing a disconnect', () => {
  let secrets: InMemorySecretStore;
  let deployKeys: InMemoryDeployKeys;
  let connections: InMemoryRepositoryConnectionRepository;
  let git: FakeRepositoryGit;
  let logs: string[];
  let cleanup: RepositoryCleanup;

  async function connect(projectId: string, name: string) {
    await connections.connect({
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
    connections = new InMemoryRepositoryConnectionRepository();
    git = new FakeRepositoryGit();
    logs = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    cleanup = new RepositoryCleanup(connections, git, deployKeys);
  });

  it.each([
    ['reading the Repository', 'find'],
    ['deleting the record', 'change'],
  ] as const)(
    'reports a store failure while %s as pending (logged redacted), never as an error',
    async (_case, method) => {
      await connect(A, 'a');
      await connections.change(A, (r) => {
        r.startDisconnect();
      });
      vi.spyOn(connections, method).mockRejectedValue(
        new Error('connect ECONNREFUSED postgres://studio:hunter2@db:5432'),
      );

      await expect(cleanup.finish(A)).resolves.toBe(false);

      expect(logs).toEqual([expect.stringContaining(A)]);
      expect(logs[0]).not.toContain('hunter2');
    },
  );

  it('reports nothing left when a concurrent cleanup deleted the record before the final delete', async () => {
    await connect(A, 'a');
    await connections.change(A, (r) => {
      r.startDisconnect();
    });
    git.removeClone.mockImplementation(async (projectId) => {
      await connections.change(projectId, (r) => {
        r.finishDisconnect();
      });
    });

    await expect(cleanup.finish(A)).resolves.toBe(true);
    expect(await connections.find(A)).toBeNull();
    expect(logs).toEqual([]);
  });

  it('never deletes a Repository that is not disconnecting', async () => {
    await connect(A, 'a');

    await expect(cleanup.finish(A)).resolves.toBe(false);
    expect((await connections.find(A))?.state).toBe('connecting');
    expect(git.removeClone).not.toHaveBeenCalled();
  });

  describe('an SSH Repository', () => {
    async function connectOverSsh(projectId: string) {
      const deployKey = await deployKeys.create('ssh');
      await connections.connect({
        projectId,
        url: 'git@git.example.com:acme/ssh.git',
        identity: 'git.example.com/acme/ssh',
        integrationBranch: 'dev',
        deployKey,
      });
      const pending = testDeployKey('host').publicKey.split(' ').slice(0, 2).join(' ');
      await connections.change(projectId, (r) => {
        r.awaitHostKey(pending);
      });
      await connections.change(projectId, (r) => {
        r.startVerifiedClone({ pendingHostKey: pending });
      });
      return deployKey;
    }

    it('deletes the private key from the secret store and forgets the pinned host key, then the record', async () => {
      await connectOverSsh(A);
      const forget = vi.spyOn(RepositoryConnection.prototype, 'forgetDeployKey');
      await connections.change(A, (r) => {
        r.startDisconnect();
      });

      expect(await cleanup.finish(A)).toBe(true);

      expect(secrets.values.size).toBe(0);
      expect(forget).toHaveBeenCalledTimes(1);
      expect(await connections.find(A)).toBeNull();
    });

    it('stays disconnecting when the secret cannot be deleted, and completes on a retry', async () => {
      await connectOverSsh(A);
      await connections.change(A, (r) => {
        r.startDisconnect();
      });
      secrets.failWith = new SecretStoreUnavailableError();

      expect(await cleanup.finish(A)).toBe(false);
      expect(await connections.find(A)).toMatchObject({
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
      await connections.change(B, (r) => {
        r.startDisconnect();
      });

      expect(await cleanup.finish(B)).toBe(true);
      expect(forget).not.toHaveBeenCalled();
    });
  });
});
