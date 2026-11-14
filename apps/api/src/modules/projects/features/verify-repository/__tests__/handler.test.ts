import { beforeEach, describe, expect, it } from 'vitest';
import { JobAlreadyActiveError } from '../../../../../platform/queue/job-queue.js';
import {
  NoRepositoryError,
  ProjectNotFoundError,
  RepositoryNotVerifiableError,
} from '../../../domain/repositories/project-repository.js';
import {
  GIT_FAILURE_WITHOUT_OUTPUT_DETAIL,
  UNEXPECTED_FAILURE_DETAIL,
} from '../../../domain/entities/repository.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { generateDeployKey, hostKeyFingerprint } from '../../../domain/value-objects/ssh-key.js';
import { GitOperationError, GitUnsupportedPlatformError } from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { RecordingRepositoryJobs } from '../../../ports/__tests__/recording-repository-jobs.js';
import { NOT_STARTED_DETAIL } from '../../connect-repository/handler.js';
import { DeployKeyHandler } from '../../deploy-key/handler.js';
import { InMemorySecretStore } from '../../deploy-key/__tests__/in-memory-secret-store.js';
import { HostKeyFingerprintMismatchError, VerifyRepositoryHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const TRUSTED_URL = 'git@github.com:acme/shop.git';
const UNLISTED_URL = 'ssh://git@git.example.com:2222/acme/shop.git';
const hostKey = (): string => generateDeployKey('host').publicKey.split(' ').slice(0, 2).join(' ');
const GITHUB_KEY = hostKey();

describe('VerifyRepositoryHandler', () => {
  let projects: InMemoryProjectRepository;
  let git: FakeRepositoryGit;
  let jobs: RecordingRepositoryJobs;
  let secrets: InMemorySecretStore;
  let deployKeys: DeployKeyHandler;
  let handler: VerifyRepositoryHandler;

  beforeEach(() => {
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    git = new FakeRepositoryGit();
    jobs = new RecordingRepositoryJobs();
    secrets = new InMemorySecretStore();
    deployKeys = new DeployKeyHandler(secrets, {
      knownHosts: [{ hosts: ['github.com'], key: GITHUB_KEY }],
    });
    handler = new VerifyRepositoryHandler(projects, git, jobs, deployKeys);
  });

  /** An SSH Repository awaiting its key, as connect stores it. */
  async function awaitingKey(url: string) {
    const deployKey = await deployKeys.create('Shop');
    return projects.beginConnect({
      projectId: PROJECT,
      url,
      identity: 'identity',
      integrationBranch: 'dev',
      deployKey,
      pinnedHostKey: null,
    });
  }

  const stored = () => projects.findRepository(PROJECT);

  describe('a host listed in the trusted host keys', () => {
    it('starts the clone at once: connecting, with the same Deploy key', async () => {
      const before = await awaitingKey(TRUSTED_URL);

      const repository = await handler.execute({ projectId: PROJECT });

      expect(repository).toMatchObject({
        state: 'connecting',
        publicKey: before.publicKey,
        deployKeySecret: before.deployKeySecret,
      });
      expect(jobs.started).toEqual([[PROJECT, 'clone']]);
      expect(git.scanHostKey).not.toHaveBeenCalled();
    });

    it('is Retry after a failed clone (auth_failed): the same key pair, no change on the host', async () => {
      const before = await awaitingKey(TRUSTED_URL);
      await handler.execute({ projectId: PROJECT });
      await projects.markFailed(PROJECT, {
        code: 'auth_failed',
        detail: 'Permission denied (publickey).',
        remoteDefaultBranch: null,
      });

      const retried = await handler.execute({ projectId: PROJECT });

      expect(retried).toMatchObject({
        state: 'connecting',
        failure: null,
        publicKey: before.publicKey,
        deployKeySecret: before.deployKeySecret,
      });
      expect(secrets.values.size).toBe(1);
      expect(jobs.started).toHaveLength(2);
    });
  });

  describe('any other host', () => {
    it('retrieves the host key and waits for the operator to confirm its fingerprint', async () => {
      const presented = hostKey();
      git.scanHostKey.mockResolvedValueOnce({ hostKey: presented });
      await awaitingKey(UNLISTED_URL);

      const repository = await handler.execute({ projectId: PROJECT });

      expect(git.scanHostKey).toHaveBeenCalledWith(UNLISTED_URL, expect.anything());
      expect(repository).toMatchObject({
        state: 'awaiting_host_key',
        pendingHostKey: presented,
        pinnedHostKey: null,
        hostKeyFingerprint: hostKeyFingerprint(presented),
      });
      expect(jobs.started).toEqual([]);
    });

    it('pins the confirmed key and starts the clone', async () => {
      const presented = hostKey();
      git.scanHostKey.mockResolvedValueOnce({ hostKey: presented });
      await awaitingKey(UNLISTED_URL);
      await handler.execute({ projectId: PROJECT });

      const repository = await handler.execute({
        projectId: PROJECT,
        acceptHostKeyFingerprint: hostKeyFingerprint(presented),
      });

      expect(repository).toMatchObject({
        state: 'connecting',
        pinnedHostKey: presented,
        pendingHostKey: null,
        hostKeyFingerprint: hostKeyFingerprint(presented),
      });
      expect(jobs.started).toEqual([[PROJECT, 'clone']]);
    });

    it('refuses another fingerprint and changes nothing', async () => {
      const presented = hostKey();
      git.scanHostKey.mockResolvedValueOnce({ hostKey: presented });
      await awaitingKey(UNLISTED_URL);
      await handler.execute({ projectId: PROJECT });

      await expect(
        handler.execute({
          projectId: PROJECT,
          acceptHostKeyFingerprint: hostKeyFingerprint(hostKey()),
        }),
      ).rejects.toBeInstanceOf(HostKeyFingerprintMismatchError);
      expect(await stored()).toMatchObject({
        state: 'awaiting_host_key',
        pendingHostKey: presented,
        pinnedHostKey: null,
      });
      expect(jobs.started).toEqual([]);
    });

    it('needs an exact match (case and padding count)', async () => {
      const presented = hostKey();
      git.scanHostKey.mockResolvedValueOnce({ hostKey: presented });
      await awaitingKey(UNLISTED_URL);
      await handler.execute({ projectId: PROJECT });

      await expect(
        handler.execute({
          projectId: PROJECT,
          acceptHostKeyFingerprint: hostKeyFingerprint(presented).toLowerCase(),
        }),
      ).rejects.toBeInstanceOf(HostKeyFingerprintMismatchError);
    });

    it('retrieves the host key again when verified without a fingerprint', async () => {
      const [first, second] = [hostKey(), hostKey()];
      git.scanHostKey
        .mockResolvedValueOnce({ hostKey: first })
        .mockResolvedValueOnce({ hostKey: second });
      await awaitingKey(UNLISTED_URL);
      await handler.execute({ projectId: PROJECT });

      const repository = await handler.execute({ projectId: PROJECT });

      expect(repository).toMatchObject({ state: 'awaiting_host_key', pendingHostKey: second });
    });

    it('uses a pinned key without asking again (Retry after a failed clone)', async () => {
      const presented = hostKey();
      git.scanHostKey.mockResolvedValueOnce({ hostKey: presented });
      await awaitingKey(UNLISTED_URL);
      await handler.execute({ projectId: PROJECT });
      await handler.execute({
        projectId: PROJECT,
        acceptHostKeyFingerprint: hostKeyFingerprint(presented),
      });
      await projects.markFailed(PROJECT, {
        code: 'auth_failed',
        detail: '',
        remoteDefaultBranch: null,
      });

      const retried = await handler.execute({ projectId: PROJECT });

      expect(retried).toMatchObject({ state: 'connecting', pinnedHostKey: presented });
      expect(git.scanHostKey).toHaveBeenCalledTimes(1);
    });

    it('fails the Repository when the host cannot be reached', async () => {
      git.scanHostKey.mockRejectedValueOnce(
        new GitOperationError('host_unreachable', 'Name or service not known'),
      );
      await awaitingKey(UNLISTED_URL);

      const repository = await handler.execute({ projectId: PROJECT });

      expect(repository).toMatchObject({
        state: 'failed',
        failure: { code: 'host_unreachable', detail: 'Name or service not known' },
      });
      expect(jobs.started).toEqual([]);
    });

    it('says Git gave no explanation when the host key scan fails without output, not that Studio stopped (#72)', async () => {
      git.scanHostKey.mockRejectedValueOnce(new GitOperationError('unknown'));
      await awaitingKey(UNLISTED_URL);

      const repository = await handler.execute({ projectId: PROJECT });

      expect(repository).toMatchObject({
        state: 'failed',
        failure: { code: 'unknown', detail: GIT_FAILURE_WITHOUT_OUTPUT_DETAIL },
      });
      expect(repository.failure?.detail).not.toBe(UNEXPECTED_FAILURE_DETAIL);
    });
  });

  describe('refusals', () => {
    it('refuses a fingerprint while no host key awaits confirmation', async () => {
      await awaitingKey(UNLISTED_URL);

      await expect(
        handler.execute({ projectId: PROJECT, acceptHostKeyFingerprint: 'SHA256:abc' }),
      ).rejects.toBeInstanceOf(RepositoryNotVerifiableError);
    });

    it('refuses an HTTPS Repository', async () => {
      await projects.beginConnect({
        projectId: PROJECT,
        url: 'https://github.com/acme/shop.git',
        identity: 'github.com/acme/shop',
        integrationBranch: 'dev',
      });
      await projects.markFailed(PROJECT, {
        code: 'unknown',
        detail: '',
        remoteDefaultBranch: null,
      });

      await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
        RepositoryNotVerifiableError,
      );
    });

    it('refuses while connecting and once ready', async () => {
      await awaitingKey(TRUSTED_URL);
      await handler.execute({ projectId: PROJECT });

      await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
        RepositoryNotVerifiableError,
      );
      await projects.markReady(PROJECT, { headSha: 'a'.repeat(40), fetchedAt: new Date() });
      await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
        RepositoryNotVerifiableError,
      );
    });

    it('reports a project without a Repository, and an unknown project', async () => {
      await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
        NoRepositoryError,
      );
      for (const projectId of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
        await expect(handler.execute({ projectId })).rejects.toBeInstanceOf(ProjectNotFoundError);
      }
    });

    it('refuses on an unsupported platform, changing nothing', async () => {
      await awaitingKey(TRUSTED_URL);
      git.supported = false;

      await expect(handler.execute({ projectId: PROJECT })).rejects.toBeInstanceOf(
        GitUnsupportedPlatformError,
      );
      expect(await stored()).toMatchObject({ state: 'awaiting_key' });
    });

    it('keeps the failure a Retry replaced when the clone cannot be scheduled', async () => {
      await awaitingKey(TRUSTED_URL);
      await handler.execute({ projectId: PROJECT });
      const authFailed = {
        code: 'auth_failed' as const,
        detail: 'Permission denied (publickey).',
        remoteDefaultBranch: null,
      };
      await projects.markFailed(PROJECT, authFailed);
      const busy = new JobAlreadyActiveError('repository-git', `repository-${PROJECT}`);
      jobs.failWith = busy;

      await expect(handler.execute({ projectId: PROJECT })).rejects.toBe(busy);
      expect(await stored()).toMatchObject({ state: 'failed', failure: authFailed });
    });

    it('marks the attempt failed when the clone cannot be scheduled, and rethrows', async () => {
      await awaitingKey(TRUSTED_URL);
      const busy = new JobAlreadyActiveError('repository-git', `repository-${PROJECT}`);
      jobs.failWith = busy;

      await expect(handler.execute({ projectId: PROJECT })).rejects.toBe(busy);
      expect(await stored()).toMatchObject({
        state: 'failed',
        failure: { code: 'unknown', detail: NOT_STARTED_DETAIL },
      });
    });
  });
});
