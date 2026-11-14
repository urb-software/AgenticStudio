import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobAlreadyActiveError } from '../../../../../platform/queue/job-queue.js';
import {
  ProjectNotFoundError,
  RemoteAlreadyConnectedError,
} from '../../../domain/repositories/project-repository.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InvalidIntegrationBranchError } from '../../../domain/value-objects/integration-branch.js';
import { InvalidRepositoryUrlError } from '../../../domain/value-objects/repository-url.js';
import { GitUnsupportedPlatformError } from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { RecordingRepositoryJobs } from '../../../ports/__tests__/recording-repository-jobs.js';
import { SecretStoreUnavailableError } from '../../../../../platform/secrets/index.js';
import { generateDeployKey } from '../../../domain/value-objects/ssh-key.js';
import { DeployKeyHandler } from '../../deploy-key/handler.js';
import { InMemorySecretStore } from '../../deploy-key/__tests__/in-memory-secret-store.js';
import {
  DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS,
  SweepOrphanedDeployKeysHandler,
} from '../../sweep-orphaned-deploy-keys/handler.js';
import { ConnectRepositoryHandler, NOT_STARTED_DETAIL } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const URL = 'https://github.com/acme/shop.git';
const SSH_URL = 'git@github.com:acme/shop.git';
const OTHER_PROJECT = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const hostKey = (): string => generateDeployKey('host').publicKey.split(' ').slice(0, 2).join(' ');

describe('ConnectRepositoryHandler', () => {
  let projects: InMemoryProjectRepository;
  let git: FakeRepositoryGit;
  let jobs: RecordingRepositoryJobs;
  let secrets: InMemorySecretStore;

  const handler = (allowFileRemotes = false) => {
    const deployKeys = new DeployKeyHandler(secrets, { knownHosts: [] });
    return new ConnectRepositoryHandler(
      projects,
      git,
      jobs,
      { allowFileRemotes },
      deployKeys,
      new SweepOrphanedDeployKeysHandler(projects, deployKeys, {
        gracePeriodMs: DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS,
      }),
    );
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    git = new FakeRepositoryGit();
    jobs = new RecordingRepositoryJobs();
    secrets = new InMemorySecretStore();
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
      hasClone: false,
      headSha: null,
      lastFetchedAt: null,
      failure: null,
      publicKey: null,
      deployKeySecret: null,
      pinnedHostKey: null,
      pendingHostKey: null,
      hostKeyFingerprint: null,
    });
    expect(projects.repositories.get(PROJECT)?.identity).toBe('github.com/acme/shop');
    expect(jobs.started).toEqual([[PROJECT, 'clone']]);
    // No Git runs in the request: the clone happens in the background job.
    expect(git.calls).toEqual([]);
  });

  it.each([
    ['http://', 'http://github.com/acme/shop.git'],
    ['a git+ssh:// URL', 'git+ssh://git@github.com/acme/shop.git'],
    ['a file:// URL without the test-only setting', 'file:///srv/shop.git'],
  ])('rejects %s before storing or scheduling anything', async (_case, url) => {
    await expect(
      handler().execute({ projectId: PROJECT, url, integrationBranch: 'dev' }),
    ).rejects.toBeInstanceOf(InvalidRepositoryUrlError);

    expect(projects.repositories.size).toBe(0);
    expect(jobs.started).toEqual([]);
    expect(secrets.values.size).toBe(0);
  });

  it('accepts a file:// URL under the test-only fixture-remote setting', async () => {
    await handler(true).execute({
      projectId: PROJECT,
      url: 'file:///srv/fixtures/shop.git',
      integrationBranch: 'dev',
    });

    expect(jobs.started).toEqual([[PROJECT, 'clone']]);
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
        url: 'http://github.com/a/b',
        integrationBranch: 'dev',
      }),
    ).rejects.toBeInstanceOf(InvalidRepositoryUrlError);
  });

  describe('over SSH (Issue #62)', () => {
    it('generates a Deploy key and stores the Repository awaiting_key, without a job or Git', async () => {
      const repository = await handler().execute({
        projectId: PROJECT,
        url: ` ${SSH_URL} `,
        integrationBranch: 'dev',
      });

      expect(repository).toMatchObject({
        url: SSH_URL,
        state: 'awaiting_key',
        hasClone: false,
        publicKey: expect.stringMatching(/^ssh-ed25519 [A-Za-z0-9+/]+=* studio-Shop$/),
        pinnedHostKey: null,
        pendingHostKey: null,
        hostKeyFingerprint: null,
      });
      // Only the secret store holds the private half; the Repository has its reference.
      expect([...secrets.values.keys()]).toEqual([repository.deployKeySecret]);
      expect(secrets.values.get(repository.deployKeySecret!)).toMatch(/PRIVATE KEY/);
      expect(JSON.stringify(repository)).not.toMatch(/PRIVATE KEY/);
      expect(jobs.started).toEqual([]);
      expect(git.calls).toEqual([]);
      expect(projects.repositories.get(PROJECT)?.identity).toBe('github.com/acme/shop');
    });

    it('refuses on an unsupported platform before generating a key (same 501 as HTTPS)', async () => {
      git.supported = false;

      await expect(
        handler().execute({ projectId: PROJECT, url: SSH_URL, integrationBranch: 'dev' }),
      ).rejects.toBeInstanceOf(GitUnsupportedPlatformError);
      expect(secrets.values.size).toBe(0);
      expect(projects.repositories.size).toBe(0);
    });

    it('stores nothing when the secret store is unavailable', async () => {
      secrets.failWith = new SecretStoreUnavailableError();

      await expect(
        handler().execute({ projectId: PROJECT, url: SSH_URL, integrationBranch: 'dev' }),
      ).rejects.toBeInstanceOf(SecretStoreUnavailableError);
      expect(projects.repositories.size).toBe(0);
    });

    it('deletes the new key when the store refuses the Repository (remote held elsewhere)', async () => {
      projects.addProject(OTHER_PROJECT, 'Other');
      await handler().execute({ projectId: OTHER_PROJECT, url: URL, integrationBranch: 'dev' });

      await expect(
        handler().execute({ projectId: PROJECT, url: SSH_URL, integrationBranch: 'dev' }),
      ).rejects.toBeInstanceOf(RemoteAlreadyConnectedError);
      expect(secrets.values.size).toBe(0);
    });

    async function failedSsh(pinnedHostKey: string | null) {
      const first = await handler().execute({
        projectId: PROJECT,
        url: SSH_URL,
        integrationBranch: 'dev',
      });
      const stored = projects.repositories.get(PROJECT)!;
      Object.assign(stored, {
        state: 'failed',
        pinnedHostKey,
        failure: { code: 'auth_failed', detail: '', remoteDefaultBranch: null },
      });
      return first;
    }

    it('keeps the Deploy key and the pinned host key when a failed one is replaced for the same host', async () => {
      const pinned = hostKey();
      const first = await failedSsh(pinned);

      const replaced = await handler().execute({
        projectId: PROJECT,
        url: 'ssh://git@github.com/acme/shop.git',
        integrationBranch: 'main',
      });

      expect(replaced).toMatchObject({
        state: 'awaiting_key',
        integrationBranch: 'main',
        publicKey: first.publicKey,
        deployKeySecret: first.deployKeySecret,
        pinnedHostKey: pinned,
        failure: null,
      });
      expect(secrets.values.size).toBe(1);
    });

    it('keeps the Deploy key but not the pinned host key for another host', async () => {
      const first = await failedSsh(hostKey());

      const replaced = await handler().execute({
        projectId: PROJECT,
        url: 'git@gitlab.com:acme/shop.git',
        integrationBranch: 'dev',
      });

      expect(replaced).toMatchObject({ publicKey: first.publicKey, pinnedHostKey: null });
    });

    it('deletes the Deploy key when a failed SSH Repository is replaced over HTTPS', async () => {
      await failedSsh(hostKey());

      const replaced = await handler().execute({
        projectId: PROJECT,
        url: URL,
        integrationBranch: 'dev',
      });

      expect(replaced).toMatchObject({
        state: 'connecting',
        publicKey: null,
        deployKeySecret: null,
        pinnedHostKey: null,
      });
      expect(secrets.values.size).toBe(0);
      expect(jobs.started).toEqual([[PROJECT, 'clone']]);
    });

    describe('when deleting the replaced Deploy key fails (Issue #76)', () => {
      let warnings: string[];

      beforeEach(() => {
        warnings = [];
        vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
          warnings.push(String(message));
        });
        vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      });

      it('still connects, and the sweep that follows deletes the key once past the grace period', async () => {
        const first = await failedSsh(hostKey());
        secrets.now += DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS;
        secrets.failNextDeleteWith = new SecretStoreUnavailableError();

        const replaced = await handler().execute({
          projectId: PROJECT,
          url: URL,
          integrationBranch: 'dev',
        });

        expect(replaced).toMatchObject({ state: 'connecting', deployKeySecret: null });
        expect(warnings).toEqual([
          expect.stringMatching(
            /could not delete an unused Deploy key\. .*SecretStoreUnavailableError/,
          ),
        ]);
        expect(secrets.values.has(first.deployKeySecret!)).toBe(false);
        expect(jobs.started).toEqual([[PROJECT, 'clone']]);
      });

      it('keeps a key inside the grace period for a later sweep', async () => {
        const first = await failedSsh(hostKey());
        secrets.now += DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS - 1;
        secrets.failNextDeleteWith = new SecretStoreUnavailableError();

        await handler().execute({ projectId: PROJECT, url: URL, integrationBranch: 'dev' });
        expect(secrets.values.has(first.deployKeySecret!)).toBe(true);

        secrets.now += 1;
        await new SweepOrphanedDeployKeysHandler(
          projects,
          new DeployKeyHandler(secrets, { knownHosts: [] }),
          { gracePeriodMs: DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS },
        ).sweep();
        expect(secrets.values.size).toBe(0);
      });
    });
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

  it('keeps the failure a Retry replaced when the old clone is still active, and rethrows', async () => {
    await projects.beginConnect({
      projectId: PROJECT,
      url: URL,
      identity: 'github.com/acme/shop',
      integrationBranch: 'release',
    });
    await projects.markFailed(PROJECT, {
      code: 'branch_not_found',
      detail: 'Branch "release" was not found on the remote.',
      remoteDefaultBranch: 'main',
    });
    const busy = new JobAlreadyActiveError('repository-git', `repository-${PROJECT}`);
    jobs.failWith = busy;

    await expect(
      handler().execute({ projectId: PROJECT, url: URL, integrationBranch: 'release' }),
    ).rejects.toBe(busy);

    expect(await projects.findRepository(PROJECT)).toMatchObject({
      state: 'failed',
      failure: {
        code: 'branch_not_found',
        detail: 'Branch "release" was not found on the remote.',
        remoteDefaultBranch: 'main',
      },
    });
  });

  it('marks the attempt failed when the clone cannot be scheduled, and rethrows', async () => {
    const busy = new JobAlreadyActiveError('repository-git', `repository-${PROJECT}`);
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
