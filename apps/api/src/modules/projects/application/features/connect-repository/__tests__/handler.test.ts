import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobAlreadyActiveError } from '../../../../../../platform/queue/job-queue.js';
import { ProjectNotFoundError } from '../../../../domain/repositories/project-repository.js';
import { RemoteAlreadyConnectedError } from '../../../../domain/repositories/repository-connection-repository.js';
import { RepositoryAlreadyConnectedError } from '../../../../domain/entities/repository.js';
import { InMemoryProjectRepository } from '../../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { InMemoryRepositoryConnectionRepository } from '../../../../domain/repositories/__tests__/in-memory-repository-connection-repository.js';
import { InvalidIntegrationBranchError } from '../../../../domain/value-objects/integration-branch.js';
import { InvalidRepositoryUrlError } from '../../../../domain/value-objects/repository-url.js';
import { GitUnsupportedPlatformError } from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { RecordingRepositoryJobs } from '../../../ports/__tests__/recording-repository-jobs.js';
import { SecretStoreUnavailableError } from '../../../../../../platform/secrets/index.js';
import { generateDeployKey } from '../../../../domain/value-objects/ssh-key.js';
import { NOT_STARTED_DETAIL } from '../../../../domain/value-objects/repository-failure.js';
import { DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS } from '../../../../domain/value-objects/deploy-key-sweep-policy.js';
import { InMemoryDeployKeys } from '../../../ports/__tests__/in-memory-deploy-keys.js';
import { InMemorySecretStore } from '../../../ports/__tests__/in-memory-secret-store.js';
import { SweepOrphanedDeployKeysHandler } from '../../sweep-orphaned-deploy-keys/handler.js';
import { ConnectRepositoryHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const URL = 'https://github.com/acme/shop.git';
const SSH_URL = 'git@github.com:acme/shop.git';
const OTHER_PROJECT = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const hostKey = (): string => generateDeployKey('host').publicKey.split(' ').slice(0, 2).join(' ');

describe('ConnectRepositoryHandler', () => {
  let projects: InMemoryProjectRepository;
  let connections: InMemoryRepositoryConnectionRepository;
  let git: FakeRepositoryGit;
  let jobs: RecordingRepositoryJobs;
  let secrets: InMemorySecretStore;

  const handler = (allowFileRemotes = false, allowPrivateRemotes = false) => {
    const deployKeys = new InMemoryDeployKeys(secrets);
    return new ConnectRepositoryHandler(
      projects,
      connections,
      git,
      jobs,
      { allowFileRemotes, allowPrivateRemotes },
      deployKeys,
      { gracePeriodMs: DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS },
    );
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    connections = new InMemoryRepositoryConnectionRepository();
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
    expect(connections.repositories.get(PROJECT)?.identity).toBe('github.com/acme/shop');
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

    expect(connections.repositories.size).toBe(0);
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

  describe('IP-literal URLs under the address policy (Issue #69)', () => {
    it.each(['https://169.254.169.254/acme/shop.git', 'git@0x7f.1:acme/shop.git'])(
      'rejects %s by default as a field error, storing nothing',
      async (url) => {
        const error = await handler()
          .execute({ projectId: PROJECT, url, integrationBranch: 'dev' })
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(InvalidRepositoryUrlError);
        expect((error as Error).message).toMatch(/^This address is not allowed/);
        expect(connections.repositories.size).toBe(0);
        expect(jobs.started).toEqual([]);
        expect(secrets.values.size).toBe(0);
      },
    );

    it('accepts a loopback or private address under STUDIO_GIT_ALLOW_PRIVATE_REMOTES', async () => {
      await handler(false, true).execute({
        projectId: PROJECT,
        url: 'https://10.0.0.5/acme/shop.git',
        integrationBranch: 'dev',
      });
      expect(jobs.started).toEqual([[PROJECT, 'clone']]);

      await expect(
        handler(false, true).execute({
          projectId: PROJECT,
          url: 'https://169.254.169.254/acme/shop.git',
          integrationBranch: 'dev',
        }),
      ).rejects.toBeInstanceOf(InvalidRepositoryUrlError);
    });
  });

  it('rejects an invalid integration branch', async () => {
    await expect(
      handler().execute({ projectId: PROJECT, url: URL, integrationBranch: 'a..b' }),
    ).rejects.toBeInstanceOf(InvalidIntegrationBranchError);
    expect(connections.repositories.size).toBe(0);
  });

  it('refuses a valid request on an unsupported platform, storing nothing', async () => {
    git.supported = false;

    await expect(
      handler().execute({ projectId: PROJECT, url: URL, integrationBranch: 'dev' }),
    ).rejects.toBeInstanceOf(GitUnsupportedPlatformError);
    expect(connections.repositories.size).toBe(0);
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
      expect(connections.repositories.get(PROJECT)?.identity).toBe('github.com/acme/shop');
    });

    it('refuses on an unsupported platform before generating a key (same 501 as HTTPS)', async () => {
      git.supported = false;

      await expect(
        handler().execute({ projectId: PROJECT, url: SSH_URL, integrationBranch: 'dev' }),
      ).rejects.toBeInstanceOf(GitUnsupportedPlatformError);
      expect(secrets.values.size).toBe(0);
      expect(connections.repositories.size).toBe(0);
    });

    it('stores nothing when the secret store is unavailable', async () => {
      secrets.failWith = new SecretStoreUnavailableError();

      await expect(
        handler().execute({ projectId: PROJECT, url: SSH_URL, integrationBranch: 'dev' }),
      ).rejects.toBeInstanceOf(SecretStoreUnavailableError);
      expect(connections.repositories.size).toBe(0);
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
      const stored = connections.repositories.get(PROJECT)!;
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

    it('never saves again a kept key a concurrent connect released (Retry read a stale Repository)', async () => {
      const first = await failedSsh(hostKey());
      const stale = (await connections.find(PROJECT))!;
      // Meanwhile another connect replaced it over HTTPS (deleting the key), and that failed.
      await handler().execute({ projectId: PROJECT, url: URL, integrationBranch: 'dev' });
      await connections.change(PROJECT, (r) => {
        r.failClone({
          code: 'unknown',
          detail: '',
          remoteDefaultBranch: null,
        });
      });
      vi.spyOn(connections, 'find').mockResolvedValueOnce(stale);

      await expect(
        handler().execute({ projectId: PROJECT, url: SSH_URL, integrationBranch: 'dev' }),
      ).rejects.toBeInstanceOf(RepositoryAlreadyConnectedError);

      expect(connections.repositories.get(PROJECT)).toMatchObject({
        state: 'failed',
        deployKeySecret: null,
      });
      expect(secrets.values.has(first.deployKeySecret!)).toBe(false);
    });

    it('never recreates a Repository a concurrent disconnect removed (Retry read a stale Repository)', async () => {
      await failedSsh(hostKey());
      const stale = (await connections.find(PROJECT))!;
      await connections.change(PROJECT, (r) => {
        r.startDisconnect();
      });
      await connections.change(PROJECT, (r) => {
        r.finishDisconnect();
      });
      vi.spyOn(connections, 'find').mockResolvedValueOnce(stale);

      await expect(
        handler().execute({ projectId: PROJECT, url: SSH_URL, integrationBranch: 'dev' }),
      ).rejects.toBeInstanceOf(RepositoryAlreadyConnectedError);

      expect(connections.repositories.has(PROJECT)).toBe(false);
      expect(jobs.started).toEqual([]);
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

      it('keeps a new key whose Repository was refused for a later sweep when its delete fails', async () => {
        projects.addProject(OTHER_PROJECT, 'Other');
        await handler().execute({ projectId: OTHER_PROJECT, url: URL, integrationBranch: 'dev' });
        secrets.failNextDeleteWith = new SecretStoreUnavailableError();

        await expect(
          handler().execute({ projectId: PROJECT, url: SSH_URL, integrationBranch: 'dev' }),
        ).rejects.toBeInstanceOf(RemoteAlreadyConnectedError);

        // Fresh, so the sweep that follows keeps it; it is deleted once past the grace period.
        expect(secrets.values.size).toBe(1);
        secrets.now += DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS;
        await new SweepOrphanedDeployKeysHandler(connections, new InMemoryDeployKeys(secrets), {
          gracePeriodMs: DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS,
        }).execute();
        expect(secrets.values.size).toBe(0);
      });

      it('keeps a key inside the grace period for a later sweep', async () => {
        const first = await failedSsh(hostKey());
        secrets.now += DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS - 1;
        secrets.failNextDeleteWith = new SecretStoreUnavailableError();

        await handler().execute({ projectId: PROJECT, url: URL, integrationBranch: 'dev' });
        expect(secrets.values.has(first.deployKeySecret!)).toBe(true);

        secrets.now += 1;
        await new SweepOrphanedDeployKeysHandler(connections, new InMemoryDeployKeys(secrets), {
          gracePeriodMs: DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS,
        }).execute();
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
    await connections.connect({
      projectId: PROJECT,
      url: URL,
      identity: 'github.com/acme/shop',
      integrationBranch: 'release',
    });
    await connections.change(PROJECT, (r) => {
      r.failClone({
        code: 'branch_not_found',
        detail: 'Branch "release" was not found on the remote.',
        remoteDefaultBranch: 'main',
      });
    });
    const busy = new JobAlreadyActiveError('repository-git', `repository-${PROJECT}`);
    jobs.failWith = busy;

    await expect(
      handler().execute({ projectId: PROJECT, url: URL, integrationBranch: 'release' }),
    ).rejects.toBe(busy);

    expect(await connections.find(PROJECT)).toMatchObject({
      state: 'failed',
      failure: {
        code: 'branch_not_found',
        detail: 'Branch "release" was not found on the remote.',
        remoteDefaultBranch: 'main',
      },
    });
  });

  it.each([
    ['the branch', URL, 'main'],
    ['the URL', 'https://github.com/acme/shop-v2.git', 'release'],
  ])(
    'stores "could not be started", not the replaced failure, when the Retry changed %s',
    async (_, url, integrationBranch) => {
      await connections.connect({
        projectId: PROJECT,
        url: URL,
        identity: 'github.com/acme/shop',
        integrationBranch: 'release',
      });
      await connections.change(PROJECT, (r) => {
        r.failClone({
          code: 'branch_not_found',
          detail: '',
          remoteDefaultBranch: 'main',
        });
      });
      jobs.failWith = new JobAlreadyActiveError('repository-git', `repository-${PROJECT}`);

      await expect(
        handler().execute({ projectId: PROJECT, url, integrationBranch }),
      ).rejects.toBeInstanceOf(JobAlreadyActiveError);

      // The new settings are stored, so the replaced failure would describe another attempt.
      expect(await connections.find(PROJECT)).toMatchObject({
        state: 'failed',
        url,
        integrationBranch,
        failure: { code: 'unknown', detail: NOT_STARTED_DETAIL, remoteDefaultBranch: null },
      });
    },
  );

  it('marks the attempt failed when the clone cannot be scheduled, and rethrows', async () => {
    const busy = new JobAlreadyActiveError('repository-git', `repository-${PROJECT}`);
    jobs.failWith = busy;

    await expect(
      handler().execute({ projectId: PROJECT, url: URL, integrationBranch: 'dev' }),
    ).rejects.toBe(busy);

    expect(await connections.find(PROJECT)).toMatchObject({
      state: 'failed',
      failure: { code: 'unknown', detail: NOT_STARTED_DETAIL, remoteDefaultBranch: null },
    });
  });
});
