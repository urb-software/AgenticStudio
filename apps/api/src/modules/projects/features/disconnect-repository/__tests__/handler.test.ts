import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JobStillRunningError,
  QueueUnavailableError,
} from '../../../../../platform/queue/job-queue.js';
import { repositoryFailure } from '../../../domain/entities/repository.js';
import {
  NoRepositoryError,
  ProjectNotFoundError,
} from '../../../domain/repositories/project-repository.js';
import { InMemoryProjectRepository } from '../../../domain/repositories/__tests__/in-memory-project-repository.js';
import { GitOperationError, GitUnsupportedPlatformError } from '../../../ports/repository-git.js';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { RecordingRepositoryJobs } from '../../../ports/__tests__/recording-repository-jobs.js';
import { CleanUpRepositoryHandler } from '../../clean-up-repository/handler.js';
import { DisconnectRepositoryHandler } from '../handler.js';
import { DeployKeyHandler } from '../../deploy-key/handler.js';
import { InMemorySecretStore } from '../../deploy-key/__tests__/in-memory-secret-store.js';
import {
  DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS,
  SweepOrphanedDeployKeysHandler,
} from '../../sweep-orphaned-deploy-keys/handler.js';
import { ConnectRepositoryHandler } from '../../connect-repository/handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const URL = 'https://github.com/acme/shop.git';
const IDENTITY = 'github.com/acme/shop';
const SHA = 'a'.repeat(40);
const FETCHED_AT = new Date('2026-11-13T10:00:00.000Z');
const FAILURE = repositoryFailure('host_unreachable', 'fatal: x');
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

describe('DisconnectRepositoryHandler', () => {
  let secrets: InMemorySecretStore;
  let deployKeys: DeployKeyHandler;
  let projects: InMemoryProjectRepository;
  let git: FakeRepositoryGit;
  let jobs: RecordingRepositoryJobs;
  let logs: string[];
  let handler: DisconnectRepositoryHandler;

  const stored = () => projects.findRepository(PROJECT);

  async function connecting(projectId = PROJECT) {
    await projects.beginConnect({
      projectId,
      url: URL,
      identity: IDENTITY,
      integrationBranch: 'dev',
    });
  }

  async function ready() {
    await connecting();
    await projects.markReady(PROJECT, { headSha: SHA, fetchedAt: FETCHED_AT });
  }

  async function fetching() {
    await ready();
    await projects.beginFetch(PROJECT);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    secrets = new InMemorySecretStore();
    deployKeys = new DeployKeyHandler(secrets, { knownHosts: [] });
    projects = new InMemoryProjectRepository();
    projects.addProject(PROJECT, 'Shop');
    projects.addProject(OTHER, 'Other');
    git = new FakeRepositoryGit();
    jobs = new RecordingRepositoryJobs();
    logs = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    const cleanup = new CleanUpRepositoryHandler(projects, git, deployKeys);
    handler = new DisconnectRepositoryHandler(projects, git, jobs, cleanup);
  });

  it('marks the Repository disconnecting, cancels its job, removes the Clone, then deletes the record', async () => {
    await ready();
    const seen: string[] = [];
    jobs.onCancel = async () => {
      seen.push(`cancel while ${(await stored())?.state}`);
    };
    git.removeClone.mockImplementation(async () => {
      seen.push(`removeClone while ${(await stored())?.state}`);
    });

    await expect(handler.execute(PROJECT)).resolves.toEqual({ disconnected: true });

    expect(seen).toEqual(['cancel while disconnecting', 'removeClone while disconnecting']);
    expect(jobs.cancelled).toEqual([PROJECT]);
    expect(await stored()).toBeNull();
    expect(logs).toEqual([]);
  });

  it('removes the Clone by project id only: no URL or path reaches the Git adapter', async () => {
    await ready();

    await handler.execute(PROJECT);

    expect(git.removeClone).toHaveBeenCalledTimes(1);
    expect(git.removeClone.mock.calls[0]![0]).toBe(PROJECT);
    expect(JSON.stringify(git.removeClone.mock.calls[0])).not.toContain('acme');
  });

  it.each([
    [
      'failed (no Clone)',
      async () => {
        await connecting();
        await projects.markFailed(PROJECT, FAILURE);
      },
    ],
    [
      'failed (Clone kept)',
      async () => {
        await fetching();
        await projects.markFetchFailed(PROJECT, FAILURE, { cloneKept: true });
      },
    ],
  ])('disconnects a Repository that is %s', async (_case, arrange) => {
    await arrange();

    await expect(handler.execute(PROJECT)).resolves.toEqual({ disconnected: true });
    expect(await stored()).toBeNull();
  });

  describe('while an operation runs, it is cancelled first and its late writes change nothing', () => {
    it.each([
      [
        'connecting: the clone ends well',
        connecting,
        () => projects.markReady(PROJECT, { headSha: SHA, fetchedAt: FETCHED_AT }),
      ],
      ['connecting: the clone fails', connecting, () => projects.markFailed(PROJECT, FAILURE)],
      [
        'fetching: the fetch ends well',
        fetching,
        () => projects.markFetched(PROJECT, { headSha: SHA, fetchedAt: FETCHED_AT }),
      ],
      [
        'fetching: the fetch fails',
        fetching,
        () => projects.markFetchFailed(PROJECT, FAILURE, { cloneKept: true }),
      ],
    ])('%s', async (_case, arrange, lateWrite) => {
      await arrange();
      const writes: boolean[] = [];
      jobs.onCancel = async () => {
        // The aborted job's last write, as its processor or onFailed would make it.
        writes.push(await lateWrite());
        expect((await stored())?.state).toBe('disconnecting');
      };

      await expect(handler.execute(PROJECT)).resolves.toEqual({ disconnected: true });

      expect(writes).toEqual([false]);
      expect(await stored()).toBeNull();
    });
  });

  describe('when cleanup cannot finish, the Repository stays disconnecting and a repeat retries', () => {
    it.each([
      ['the queue is unavailable', new QueueUnavailableError()],
      [
        'the job did not stop in time',
        new JobStillRunningError('repository-git', `repository-${PROJECT}`),
      ],
    ])('cancel fails (%s): nothing is removed yet', async (_case, error) => {
      await ready();
      jobs.cancelFailsWith = error;

      const outcome = await handler.execute(PROJECT);

      expect(outcome).toEqual({
        disconnected: false,
        repository: expect.objectContaining({ state: 'disconnecting', hasClone: false }),
      });
      expect(git.removeClone).not.toHaveBeenCalled();
      expect((await stored())?.state).toBe('disconnecting');
      expect(logs).toEqual([expect.stringContaining(PROJECT)]);

      jobs.cancelFailsWith = undefined;
      await expect(handler.execute(PROJECT)).resolves.toEqual({ disconnected: true });
      expect(await stored()).toBeNull();
    });

    it('the Clone cannot be removed: logged redacted, then a repeat completes', async () => {
      await ready();
      git.removeClone.mockRejectedValueOnce(new Error(`EACCES token=${TOKEN}`));

      const outcome = await handler.execute(PROJECT);

      expect(outcome).toMatchObject({
        disconnected: false,
        repository: { state: 'disconnecting' },
      });
      expect((await stored())?.state).toBe('disconnecting');
      expect(logs).toEqual([expect.stringContaining(PROJECT)]);
      expect(logs[0]).not.toContain(TOKEN);

      await expect(handler.execute(PROJECT)).resolves.toEqual({ disconnected: true });
      expect(await stored()).toBeNull();
    });

    it('the database fails during cleanup: pending (202), not an error', async () => {
      await ready();
      const deleteDisconnecting = projects.deleteDisconnecting.bind(projects);
      projects.deleteDisconnecting = () => Promise.reject(new Error('database down'));

      await expect(handler.execute(PROJECT)).resolves.toMatchObject({
        disconnected: false,
        repository: { state: 'disconnecting' },
      });
      expect(logs).toEqual([expect.stringContaining(PROJECT)]);

      projects.deleteDisconnecting = deleteDisconnecting;
      await expect(handler.execute(PROJECT)).resolves.toEqual({ disconnected: true });
    });

    it('a Git failure of the removal is pending too', async () => {
      await ready();
      git.removeClone.mockRejectedValueOnce(new GitOperationError('unknown', 'EBUSY'));

      await expect(handler.execute(PROJECT)).resolves.toMatchObject({ disconnected: false });
      expect((await stored())?.state).toBe('disconnecting');
    });
  });

  it('frees the remote: it can be connected again to this or another project', async () => {
    await ready();
    await handler.execute(PROJECT);

    await connecting(OTHER);
    expect((await projects.findRepository(OTHER))?.state).toBe('connecting');
    await handler.execute(OTHER);
    await connecting(PROJECT);
    expect((await stored())?.state).toBe('connecting');
  });

  it('refuses an unknown project, an id that is not a UUID and a project without a Repository', async () => {
    await expect(handler.execute('00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      ProjectNotFoundError,
    );
    await expect(handler.execute('not-a-uuid')).rejects.toThrow(ProjectNotFoundError);
    await expect(handler.execute(PROJECT)).rejects.toThrow(NoRepositoryError);
    expect(jobs.cancelled).toEqual([]);
    expect(git.removeClone).not.toHaveBeenCalled();
  });

  it('refuses on a host that is not Linux before changing anything', async () => {
    await ready();
    git.supported = false;

    await expect(handler.execute(PROJECT)).rejects.toThrow(GitUnsupportedPlatformError);
    expect((await stored())?.state).toBe('ready');
    expect(jobs.cancelled).toEqual([]);
  });

  it("removes an SSH Repository's Deploy key; connecting again generates a new key pair (Issue #62)", async () => {
    const connect = new ConnectRepositoryHandler(
      projects,
      git,
      jobs,
      { allowFileRemotes: false, allowPrivateRemotes: false },
      deployKeys,
      new SweepOrphanedDeployKeysHandler(projects, deployKeys, {
        gracePeriodMs: DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS,
      }),
    );
    const input = {
      projectId: PROJECT,
      url: 'git@github.com:acme/shop.git',
      integrationBranch: 'dev',
    };
    const first = await connect.execute(input);
    expect(secrets.values.size).toBe(1);

    expect(await handler.execute(PROJECT)).toEqual({ disconnected: true });
    expect(secrets.values.size).toBe(0);
    expect(await projects.findRepository(PROJECT)).toBeNull();

    const second = await connect.execute(input);
    expect(second.state).toBe('awaiting_key');
    expect(second.publicKey).not.toBe(first.publicKey);
    expect(second.deployKeySecret).not.toBe(first.deployKeySecret);
    expect([...secrets.values.keys()]).toEqual([second.deployKeySecret]);
  });
});
