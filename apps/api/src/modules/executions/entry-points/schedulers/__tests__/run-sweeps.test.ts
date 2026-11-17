import { describe, expect, it } from 'vitest';
import { CancelLongWaitingRunsHandler } from '../../../application/features/cancel-long-waiting-runs/handler.js';
import { ReleaseFinalSnapshotsHandler } from '../../../application/features/release-final-snapshots/handler.js';
import { RenewHeldRunLeasesHandler } from '../../../application/features/renew-held-run-leases/handler.js';
import { SweepLostWorkersHandler } from '../../../application/features/sweep-lost-workers/handler.js';
import { TimeOutOverdueStepsHandler } from '../../../application/features/time-out-overdue-steps/handler.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { RunSweepsScheduler } from '../run-sweeps.js';

// Review of #121: the API renews held Runs' leases when it starts, but at most once per lease
// period, so an API that keeps crashing and restarting cannot keep a dead worker's Run alive.
const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const LEASE = { seconds: 60 };
/** No worker has reported (the sweep only needs it for delivery retries, #102). */
const STATUSES = { record: () => undefined, latest: () => undefined, lastSeen: () => undefined };
const NO_SNAPSHOTS = {
  releaseFor: () => Promise.resolve(),
  releaseFinal: () => Promise.resolve(),
};
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe('RunSweepsScheduler at API start', () => {
  async function setUp() {
    const runs = new InMemoryRunRepository();
    await runs.start({
      projectId: PROJECT,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      integrationBranch: 'dev',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
    });
    const run = (await runs.claimNext(WORKER, T0))!;
    const clock = { current: T0, now: () => clock.current };
    /** One API start: the schedule boots (renewing leases if allowed) and stops again. */
    const start = async () => {
      const schedule = new RunSweepsScheduler(
        new SweepLostWorkersHandler(runs, clock, LEASE, STATUSES, NO_SNAPSHOTS),
        new TimeOutOverdueStepsHandler(runs, clock),
        new CancelLongWaitingRunsHandler(runs, clock),
        new RenewHeldRunLeasesHandler(runs, clock, LEASE),
        new ReleaseFinalSnapshotsHandler(NO_SNAPSHOTS),
        { intervalMs: 30_000 },
      );
      await schedule.onApplicationBootstrap();
      schedule.onApplicationShutdown();
      return schedule;
    };
    const sweep = () =>
      new SweepLostWorkersHandler(runs, clock, LEASE, STATUSES, NO_SNAPSHOTS).execute();
    return { runs, run, clock, start, sweep };
  }

  it('renews the held Runs once, so a short outage fails none', async () => {
    const { runs, run, clock, start, sweep } = await setUp();
    clock.current = later(300);

    await start();
    clock.current = later(300 + 50);

    expect(await sweep()).toBe(0);
    expect((await runs.findById(run.id))?.state).toBe('preparing');
  });

  it('does not renew again within a lease: a crash loop cannot keep a dead worker alive', async () => {
    const { runs, run, clock, start, sweep } = await setUp();
    clock.current = later(300);
    await start();
    // The API crashes and restarts every 30 s; the worker is gone.
    for (const at of [330, 345, 359]) {
      clock.current = later(at);
      await start();
    }
    clock.current = later(300 + 61);

    expect(await sweep()).toBe(1);
    expect((await runs.findById(run.id))?.failure?.code).toBe('worker_lost');
  });
});

describe('RunSweepsScheduler tick', () => {
  it('runs the sweeps in order and keeps going to the last one', async () => {
    const calls: string[] = [];
    const sweep = (name: string, result: number | void) => ({
      execute: () => {
        calls.push(name);
        return Promise.resolve(result);
      },
    });
    const scheduler = new RunSweepsScheduler(
      sweep('lost-workers', 0) as unknown as SweepLostWorkersHandler,
      sweep('overdue-steps', 0) as unknown as TimeOutOverdueStepsHandler,
      sweep('long-waits', 0) as unknown as CancelLongWaitingRunsHandler,
      sweep('leases', 0) as unknown as RenewHeldRunLeasesHandler,
      sweep('snapshots', undefined) as unknown as ReleaseFinalSnapshotsHandler,
      { intervalMs: 30_000 },
    );

    await scheduler.tick();

    expect(calls).toEqual(['lost-workers', 'overdue-steps', 'long-waits', 'snapshots']);
  });

  it('logs a failed sweep and runs again at the next tick', async () => {
    let attempts = 0;
    const failing = {
      execute: () => {
        attempts++;
        return Promise.reject(new Error('The database is down'));
      },
    } as unknown as SweepLostWorkersHandler;
    const idle = { execute: () => Promise.resolve(0) };
    const scheduler = new RunSweepsScheduler(
      failing,
      idle as unknown as TimeOutOverdueStepsHandler,
      idle as unknown as CancelLongWaitingRunsHandler,
      idle as unknown as RenewHeldRunLeasesHandler,
      idle as unknown as ReleaseFinalSnapshotsHandler,
      { intervalMs: 30_000 },
    );

    await scheduler.tick();
    await scheduler.tick();

    expect(attempts).toBe(2);
  });
});
