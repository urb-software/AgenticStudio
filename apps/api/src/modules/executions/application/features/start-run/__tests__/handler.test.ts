import { beforeEach, describe, expect, it } from 'vitest';
import type { RunStartPoint, RunStartPoints } from '../../../../../projects/contracts/index.js';
import {
  RepositoryNotReadyError,
  RunProjectNotFoundError,
} from '../../../../domain/entities/run.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { ProviderUnavailableError } from '../../../../domain/value-objects/worker-status.js';
import type { RecordedWorkerStatus } from '../../../../domain/value-objects/worker-status.js';
import type { WorkerStatusStore } from '../../../ports/worker-status-store.js';
import { StartRunHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const HEAD = 'd'.repeat(40);
const REMOTE = 'git@github.com:acme/shop.git';
const NOW = new Date('2026-11-15T12:00:00.000Z');
const LEASE = { seconds: 60 };
const LIMITS = { stepMinutes: 45, maxSteps: 5, waitingDays: 3, maxTotalSteps: 20 };

class InMemoryWorkerStatusStore implements WorkerStatusStore {
  private current: RecordedWorkerStatus | undefined;
  record(status: RecordedWorkerStatus) {
    this.current = status;
  }
  latest() {
    return this.current;
  }
  lastSeen() {
    return undefined;
  }
}

describe('StartRunHandler', () => {
  let runs: InMemoryRunRepository;
  let startPoint: RunStartPoint;
  let statuses: InMemoryWorkerStatusStore;
  const clock = { now: () => NOW };

  const startPoints: RunStartPoints = { forProject: () => Promise.resolve(startPoint) };
  const start = () =>
    new StartRunHandler(runs, startPoints, statuses, clock, LEASE, LIMITS).execute({
      projectId: PROJECT,
      provider: 'codex',
      task: 'Fix the login bug',
    });
  const workerReports = (codex: boolean, ageSeconds = 0) =>
    statuses.record({
      workerId: '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d',
      runner: 'cli',
      providers: { claude_code: true, codex },
      reportedAt: new Date(NOW.getTime() - ageSeconds * 1000),
    });

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    startPoint = {
      status: 'ready',
      startCommit: HEAD,
      remoteUrl: REMOTE,
      integrationBranch: 'dev',
    };
    statuses = new InMemoryWorkerStatusStore();
    workerReports(true);
  });

  it('copies the limits in force onto the Run (Issue #100)', async () => {
    const run = await start();

    expect(run.limits).toEqual(LIMITS);
    expect(run).toMatchObject({ cancelRequestedAt: null, cancellation: null, waitingSince: null });
  });

  it('queues a Run that starts from the current integration branch commit', async () => {
    const run = await start();

    expect(run).toMatchObject({
      projectId: PROJECT,
      provider: 'codex',
      task: 'Fix the login bug',
      state: 'queued',
      startCommit: HEAD,
      // Issue #98: recorded with the commit, so the Run fetches the remote the commit is from.
      remoteUrl: REMOTE,
      // Issue #102: the pull request's base, recorded with the commit it starts from.
      integrationBranch: 'dev',
      delivery: null,
      pullRequest: null,
      deliveryRequested: false,
      workingCopy: null,
      startedAt: null,
      finishedAt: null,
      failure: null,
    });
    expect(await runs.findById(run.id)).toEqual(run);
  });

  it('rejects an unknown project', async () => {
    startPoint = { status: 'project_not_found' };

    await expect(start()).rejects.toBeInstanceOf(RunProjectNotFoundError);
    expect(runs.runs).toEqual([]);
  });

  it.each([
    ['no_repository', 'no_repository'],
    ['repository_not_ready', 'not_ready'],
  ] as const)('rejects a project whose start point is %s', async (status, reason) => {
    startPoint = { status };

    await expect(start()).rejects.toEqual(new RepositoryNotReadyError(reason));
    expect(runs.runs).toEqual([]);
  });

  describe('provider availability (Issue #101)', () => {
    it.each([
      [
        'the worker reports it switched off',
        () => workerReports(false),
        'Switched off on the agent worker',
      ],
      [
        'no worker has reported',
        () => (statuses = new InMemoryWorkerStatusStore()),
        'No agent worker is connected',
      ],
      [
        'the last report is older than the lease',
        () => workerReports(true, 61),
        'No agent worker is connected',
      ],
    ])('refuses the provider when %s, starting nothing', async (_case, arrange, reason) => {
      arrange();

      await expect(start()).rejects.toEqual(new ProviderUnavailableError('codex', reason as never));
      expect(runs.runs).toEqual([]);
    });

    it('checks the project and its Repository first', async () => {
      statuses = new InMemoryWorkerStatusStore();
      startPoint = { status: 'project_not_found' };

      await expect(start()).rejects.toBeInstanceOf(RunProjectNotFoundError);
    });
  });
});
