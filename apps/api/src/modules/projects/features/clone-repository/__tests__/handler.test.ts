import { beforeEach, describe, expect, it } from 'vitest';
import { JobAbortedError } from '../../../../../platform/queue/job-queue.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import {
  GIT_FAILURE_REASONS,
  GitOperationError,
  GitRequestRejectedError,
} from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { CloneRepositoryHandler } from '../handler.js';
import { generateDeployKey } from '../../../domain/value-objects/ssh-key.js';
import { NO_TRUSTED_HOST_KEY_DETAIL } from '../../deploy-key/handler.js';
import { DeployKeyHandler } from '../../deploy-key/handler.js';
import { InMemorySecretStore } from '../../deploy-key/__tests__/in-memory-secret-store.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const URL = 'https://github.com/acme/shop.git';
const COMMIT = 'b'.repeat(40);

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

describe('CloneRepositoryHandler', () => {
  let secrets: InMemorySecretStore;
  let deployKeys: DeployKeyHandler;
  let projects: InMemoryProjectRepository;
  let git: FakeRepositoryGit;
  let handler: CloneRepositoryHandler;

  const run = (signal = new AbortController().signal) => handler.process(PROJECT, signal);

  async function connecting(integrationBranch = 'dev') {
    await projects.beginConnect({
      projectId: PROJECT,
      url: URL,
      identity: 'github.com/acme/shop',
      integrationBranch,
    });
  }

  beforeEach(() => {
    secrets = new InMemorySecretStore();
    deployKeys = new DeployKeyHandler(secrets, { knownHosts: [] });
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    git = new FakeRepositoryGit();
    handler = new CloneRepositoryHandler(projects, git, deployKeys);
  });

  it('removes any leftover Clone, inspects the remote, clones, and marks the Repository ready', async () => {
    await connecting();
    git.clone.mockResolvedValueOnce({ commit: COMMIT });

    await run();

    expect(git.calls).toEqual(['removeClone', 'inspectRemote', 'clone']);
    expect(git.clone).toHaveBeenCalledWith(PROJECT, URL, 'dev', expect.anything());
    expect(await projects.findRepository(PROJECT)).toMatchObject({
      state: 'ready',
      hasClone: true,
      headSha: COMMIT,
      lastFetchedAt: expect.any(Date),
      failure: null,
    });
  });

  it('passes the job signal to every Git operation', async () => {
    await connecting();
    const controller = new AbortController();

    await run(controller.signal);

    for (const operation of [git.removeClone, git.inspectRemote, git.clone]) {
      expect(operation.mock.calls[0]!.at(-1)).toEqual({ signal: controller.signal });
    }
  });

  it('fails with branch_not_found naming the remote default branch, without cloning', async () => {
    await connecting('release');
    git.inspectRemote.mockResolvedValueOnce({ defaultBranch: 'main', branchExists: false });

    await run();

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

    await run();

    expect((await projects.findRepository(PROJECT))?.failure?.remoteDefaultBranch).toBeNull();
  });

  it.each(GIT_FAILURE_REASONS)(
    'stores the Git failure %s with its redacted detail',
    async (reason) => {
      await connecting();
      git.clone.mockRejectedValueOnce(new GitOperationError(reason, 'fatal: <redacted>'));

      await run();

      expect((await projects.findRepository(PROJECT))?.failure).toEqual({
        code: reason,
        detail: 'fatal: <redacted>',
        remoteDefaultBranch: null,
      });
    },
  );

  it('leaves a failed connect with no usable Clone', async () => {
    await connecting();
    git.clone.mockRejectedValueOnce(new GitOperationError('host_unreachable'));

    await run();

    expect(await projects.findRepository(PROJECT)).toMatchObject({
      state: 'failed',
      hasClone: false,
      headSha: null,
      lastFetchedAt: null,
    });
  });

  it('cuts an over-long detail', async () => {
    await connecting();
    git.inspectRemote.mockRejectedValueOnce(new GitOperationError('unknown', 'x'.repeat(5000)));

    await run();

    expect((await projects.findRepository(PROJECT))?.failure?.detail).toHaveLength(2000);
  });

  it('does nothing for a job whose Repository is no longer connecting', async () => {
    await connecting();
    await projects.markFailed(PROJECT, {
      code: 'unknown',
      detail: 'Interrupted',
      remoteDefaultBranch: null,
    });

    await run();

    expect(git.calls).toEqual([]);
  });

  it('honours an abort before it starts: no Git runs', async () => {
    await connecting();
    const controller = new AbortController();
    controller.abort(new JobAbortedError('cancelled'));

    await expect(run(controller.signal)).rejects.toBeInstanceOf(JobAbortedError);
    expect(git.calls).toEqual([]);
  });

  it('lets an abort during Git propagate and leaves the failure to onFailed', async () => {
    await connecting();
    const controller = new AbortController();
    git.clone.mockImplementationOnce(() => {
      controller.abort(new JobAbortedError('timeout'));
      return Promise.reject(abortError());
    });

    await expect(run(controller.signal)).rejects.toThrow('aborted');
    expect((await projects.findRepository(PROJECT))?.state).toBe('connecting');

    await handler.onFailed(PROJECT, { reason: 'timeout' });
    expect((await projects.findRepository(PROJECT))?.failure).toMatchObject({ code: 'timeout' });
  });

  it('rethrows an unexpected error, so onFailed stores unknown', async () => {
    await connecting();
    git.removeClone.mockRejectedValueOnce(new GitRequestRejectedError('unexpected'));

    await expect(run()).rejects.toBeInstanceOf(GitRequestRejectedError);
  });

  it.each([
    ['stalled', { code: 'unknown', detail: 'Interrupted' }],
    ['shutdown', { code: 'unknown', detail: 'Interrupted' }],
    ['cancelled', { code: 'unknown', detail: 'Cancelled' }],
    ['timeout', { code: 'timeout' }],
  ] as const)('onFailed stores %s as %j', async (reason, failure) => {
    await connecting();

    await handler.onFailed(PROJECT, { reason });

    expect((await projects.findRepository(PROJECT))?.failure).toMatchObject(failure);
  });

  it('onFailed stores an unexpected error as unknown with no detail', async () => {
    await connecting();

    await handler.onFailed(PROJECT, { reason: 'error', error: new Error('db down') });

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

    await handler.reconcile();
    await handler.reconcile();

    expect((await projects.findRepository(PROJECT))?.failure).toEqual({
      code: 'unknown',
      detail: 'Interrupted',
      remoteDefaultBranch: null,
    });
    expect((await projects.findRepository(other))?.state).toBe('ready');
  });

  describe('an SSH Repository (Issue #62)', () => {
    const SSH_URL = 'git@github.com:acme/shop.git';
    const trusted = generateDeployKey('host').publicKey.split(' ').slice(0, 2).join(' ');
    const pinned = generateDeployKey('host').publicKey.split(' ').slice(0, 2).join(' ');

    async function connectingOverSsh(pinnedHostKey: string | null) {
      const deployKey = await deployKeys.create('Shop');
      await projects.beginConnect({
        projectId: PROJECT,
        url: SSH_URL,
        identity: 'github.com/acme/shop',
        integrationBranch: 'dev',
        deployKey,
        pinnedHostKey,
      });
      await projects.beginVerifiedClone(PROJECT, null);
      return deployKey;
    }

    it('clones with the Deploy key from the secret store and the trusted host keys only', async () => {
      deployKeys = new DeployKeyHandler(secrets, {
        knownHosts: [{ hosts: ['github.com'], key: trusted }],
      });
      handler = new CloneRepositoryHandler(projects, git, deployKeys);
      const { secret } = await connectingOverSsh(pinned);
      git.clone.mockResolvedValueOnce({ commit: COMMIT });

      await run();

      const ssh = { privateKey: await secrets.get(secret), hostKeys: [trusted, pinned] };
      expect(git.inspectRemote).toHaveBeenCalledWith(
        SSH_URL,
        'dev',
        expect.objectContaining({ ssh }),
      );
      expect(git.clone).toHaveBeenCalledWith(
        PROJECT,
        SSH_URL,
        'dev',
        expect.objectContaining({ ssh }),
      );
      expect(await projects.findRepository(PROJECT)).toMatchObject({ state: 'ready' });
    });

    it('fails with host_key_mismatch before Git runs when no host key is trusted', async () => {
      await connectingOverSsh(null);

      await run();

      expect(git.calls).toEqual([]);
      expect(await projects.findRepository(PROJECT)).toMatchObject({
        state: 'failed',
        failure: { code: 'host_key_mismatch', detail: NO_TRUSTED_HOST_KEY_DETAIL },
      });
    });

    it('fails with auth_failed when the host refuses the key, keeping the key pair', async () => {
      const { secret, publicKey } = await connectingOverSsh(pinned);
      git.inspectRemote.mockRejectedValueOnce(
        new GitOperationError('auth_failed', 'git@github.com: Permission denied (publickey).'),
      );

      await run();

      expect(await projects.findRepository(PROJECT)).toMatchObject({
        state: 'failed',
        failure: { code: 'auth_failed' },
        publicKey,
        deployKeySecret: secret,
      });
      expect(secrets.values.has(secret)).toBe(true);
    });
  });
});
