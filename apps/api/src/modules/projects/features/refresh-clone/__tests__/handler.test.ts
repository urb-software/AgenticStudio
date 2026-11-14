import { beforeEach, describe, expect, it } from 'vitest';
import { JobAbortedError } from '../../../../../platform/queue/job-queue.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import {
  GIT_FAILURE_REASONS,
  GitCloneMissingError,
  GitOperationError,
  GitRequestRejectedError,
} from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { CLONE_MISSING_DETAIL, RefreshCloneHandler } from '../handler.js';
import { HOST_KEY_CHANGED_DETAIL } from '../../../domain/entities/repository.js';
import { generateDeployKey } from '../../../domain/value-objects/ssh-key.js';
import { NO_TRUSTED_HOST_KEY_DETAIL } from '../../deploy-key/handler.js';
import { DeployKeyHandler } from '../../deploy-key/handler.js';
import { InMemorySecretStore } from '../../deploy-key/__tests__/in-memory-secret-store.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const URL = 'https://github.com/acme/shop.git';
const OLD = 'a'.repeat(40);
const NEW = 'c'.repeat(40);
const FETCHED_AT = new Date('2026-11-13T10:00:00.000Z');

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

describe('RefreshCloneHandler', () => {
  let secrets: InMemorySecretStore;
  let deployKeys: DeployKeyHandler;
  let projects: InMemoryProjectRepository;
  let git: FakeRepositoryGit;
  let handler: RefreshCloneHandler;

  const run = (signal = new AbortController().signal) => handler.process(PROJECT, signal);
  const stored = () => projects.findRepository(PROJECT);

  /** A Repository connected with commit OLD, now `fetching`. */
  async function fetching(integrationBranch = 'dev') {
    await projects.beginConnect({
      projectId: PROJECT,
      url: URL,
      identity: 'github.com/acme/shop',
      integrationBranch,
    });
    await projects.markReady(PROJECT, { headSha: OLD, fetchedAt: FETCHED_AT });
    await projects.beginFetch(PROJECT);
  }

  beforeEach(() => {
    secrets = new InMemorySecretStore();
    deployKeys = new DeployKeyHandler(secrets, { knownHosts: [] });
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    git = new FakeRepositoryGit();
    handler = new RefreshCloneHandler(projects, git, deployKeys);
  });

  it('fetches the Integration branch and marks the Repository ready with the new commit', async () => {
    await fetching();
    git.fetch.mockResolvedValueOnce({ commit: NEW });

    await run();

    expect(git.calls).toEqual(['fetch']);
    expect(git.fetch).toHaveBeenCalledWith(PROJECT, URL, 'dev', expect.anything());
    const repository = await stored();
    expect(repository).toMatchObject({
      state: 'ready',
      hasClone: true,
      headSha: NEW,
      failure: null,
    });
    expect(repository!.lastFetchedAt!.getTime()).toBeGreaterThan(FETCHED_AT.getTime());
  });

  it('marks ready with the same commit and a new fetch time when nothing changed', async () => {
    await fetching();
    git.fetch.mockResolvedValueOnce({ commit: OLD });

    await run();

    const repository = await stored();
    expect(repository).toMatchObject({ state: 'ready', headSha: OLD });
    expect(repository!.lastFetchedAt!.getTime()).toBeGreaterThan(FETCHED_AT.getTime());
  });

  it('passes the job signal to the fetch', async () => {
    await fetching();
    git.fetch.mockResolvedValueOnce({ commit: NEW });
    const controller = new AbortController();

    await run(controller.signal);

    expect(git.fetch.mock.calls[0]!.at(-1)).toEqual({ signal: controller.signal });
  });

  it.each(GIT_FAILURE_REASONS.filter((reason) => reason !== 'size_limit'))(
    'stores %s, keeping the Clone, the previous commit and the last fetch time',
    async (reason) => {
      await fetching();
      git.fetch.mockRejectedValueOnce(new GitOperationError(reason, 'fatal: <redacted>'));

      await run();

      expect(await stored()).toMatchObject({
        state: 'failed',
        hasClone: true,
        headSha: OLD,
        lastFetchedAt: FETCHED_AT,
        failure: { code: reason, remoteDefaultBranch: null },
      });
    },
  );

  it('stores the redacted Git detail of a failure', async () => {
    await fetching();
    git.fetch.mockRejectedValueOnce(new GitOperationError('host_unreachable', 'fatal: <redacted>'));

    await run();

    expect((await stored())?.failure?.detail).toBe('fatal: <redacted>');
  });

  it('names the branch when it no longer exists on the remote', async () => {
    await fetching('release');
    git.fetch.mockRejectedValueOnce(new GitOperationError('branch_not_found', 'fatal: x'));

    await run();

    expect((await stored())?.failure).toEqual({
      code: 'branch_not_found',
      detail: 'Branch "release" was not found on the remote.',
      remoteDefaultBranch: null,
    });
  });

  it('records size_limit with no usable Clone: the adapter removed it, so only Retry helps', async () => {
    await fetching();
    git.fetch.mockRejectedValueOnce(new GitOperationError('size_limit'));

    await run();

    expect(await stored()).toMatchObject({
      state: 'failed',
      hasClone: false,
      headSha: null,
      lastFetchedAt: null,
      failure: { code: 'size_limit' },
    });
  });

  it('does nothing for a job whose Repository is no longer fetching', async () => {
    await fetching();
    await projects.markFetchFailed(
      PROJECT,
      { code: 'unknown', detail: 'Interrupted', remoteDefaultBranch: null },
      { cloneKept: true },
    );

    await run();

    expect(git.calls).toEqual([]);
  });

  it('honours an abort before it starts: no Git runs', async () => {
    await fetching();
    const controller = new AbortController();
    controller.abort(new JobAbortedError('cancelled'));

    await expect(run(controller.signal)).rejects.toBeInstanceOf(JobAbortedError);
    expect(git.calls).toEqual([]);
  });

  it('lets an abort during the fetch propagate and leaves the failure to onFailed', async () => {
    await fetching();
    const controller = new AbortController();
    git.fetch.mockImplementationOnce(() => {
      controller.abort(new JobAbortedError('timeout'));
      return Promise.reject(abortError());
    });

    await expect(run(controller.signal)).rejects.toThrow('aborted');
    expect((await stored())?.state).toBe('fetching');

    await handler.onFailed(PROJECT, { reason: 'timeout' });
    expect(await stored()).toMatchObject({
      state: 'failed',
      hasClone: true,
      headSha: OLD,
      failure: { code: 'timeout' },
    });
  });

  it('records no usable Clone when the Clone is missing on disk, so only Retry helps', async () => {
    await fetching();
    git.fetch.mockRejectedValueOnce(new GitCloneMissingError());

    await run();

    expect(await stored()).toMatchObject({
      state: 'failed',
      hasClone: false,
      headSha: null,
      lastFetchedAt: null,
      failure: { code: 'unknown', detail: CLONE_MISSING_DETAIL },
    });
  });

  it('rethrows an unexpected error, so onFailed stores unknown', async () => {
    await fetching();
    git.fetch.mockRejectedValueOnce(new GitRequestRejectedError('Invalid remote URL.'));

    await expect(run()).rejects.toBeInstanceOf(GitRequestRejectedError);
  });

  it.each([
    ['stalled', { code: 'unknown', detail: 'Interrupted' }],
    ['shutdown', { code: 'unknown', detail: 'Interrupted' }],
    ['cancelled', { code: 'unknown', detail: 'Cancelled' }],
    ['timeout', { code: 'timeout', detail: 'The fetch took too long and was stopped.' }],
    ['error', { code: 'unknown', detail: '' }],
  ] as const)('onFailed stores %s as %j and keeps the Clone', async (reason, failure) => {
    await fetching();

    await handler.onFailed(
      PROJECT,
      reason === 'error' ? { reason, error: new Error('db down') } : { reason },
    );

    expect(await stored()).toMatchObject({
      state: 'failed',
      hasClone: true,
      headSha: OLD,
      lastFetchedAt: FETCHED_AT,
      failure,
    });
  });

  it('reconcile fails every fetching Repository as Interrupted with its Clone kept, idempotently', async () => {
    await fetching();

    await handler.reconcile();
    await handler.reconcile();

    expect(await stored()).toMatchObject({
      state: 'failed',
      hasClone: true,
      headSha: OLD,
      failure: { code: 'unknown', detail: 'Interrupted', remoteDefaultBranch: null },
    });
  });

  describe('an SSH Repository (Issue #62)', () => {
    const SSH_URL = 'ssh://git@git.example.com:2222/acme/shop.git';
    const pinned = generateDeployKey('host').publicKey.split(' ').slice(0, 2).join(' ');

    async function fetchingOverSsh(pinnedHostKey: string | null) {
      const deployKey = await deployKeys.create('Shop');
      await projects.beginConnect({
        projectId: PROJECT,
        url: SSH_URL,
        identity: 'git.example.com:2222/acme/shop',
        integrationBranch: 'dev',
        deployKey,
        pinnedHostKey,
      });
      await projects.beginVerifiedClone(PROJECT, null);
      await projects.markReady(PROJECT, { headSha: OLD, fetchedAt: FETCHED_AT });
      await projects.beginFetch(PROJECT);
      return deployKey;
    }

    it('fetches with the same Deploy key and the pinned host key', async () => {
      const { secretRef } = await fetchingOverSsh(pinned);
      git.fetch.mockResolvedValueOnce({ commit: NEW });

      await run();

      expect(git.fetch).toHaveBeenCalledWith(
        PROJECT,
        SSH_URL,
        'dev',
        expect.objectContaining({
          ssh: { privateKey: await secrets.get(secretRef), hostKeys: [pinned] },
        }),
      );
      expect(await stored()).toMatchObject({ state: 'ready', headSha: NEW });
    });

    it('fails with host_key_mismatch when the host presents another key, keeping the Clone', async () => {
      await fetchingOverSsh(pinned);
      git.fetch.mockRejectedValueOnce(
        new GitOperationError('host_key_mismatch', 'Host key verification failed.'),
      );

      await run();

      expect(await stored()).toMatchObject({
        state: 'failed',
        hasClone: true,
        headSha: OLD,
        pinnedHostKey: pinned,
        failure: {
          code: 'host_key_mismatch',
          detail: `${HOST_KEY_CHANGED_DETAIL}\n\nHost key verification failed.`,
        },
      });
    });

    it('fails with host_key_mismatch, keeping the Clone, when no host key is trusted any more', async () => {
      await fetchingOverSsh(null);

      await run();

      expect(git.fetch).not.toHaveBeenCalled();
      expect(await stored()).toMatchObject({
        state: 'failed',
        hasClone: true,
        failure: { code: 'host_key_mismatch', detail: NO_TRUSTED_HOST_KEY_DETAIL },
      });
    });
  });
});
