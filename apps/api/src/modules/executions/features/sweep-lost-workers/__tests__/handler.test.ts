import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { SweepLostWorkersHandler } from '../handler.js';

// Issue #96: a claimed Run whose worker sends no heartbeat within the lease becomes failed
// with worker_lost. The clock is injected, so no test waits.
const PROJECTS = [
  '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
  '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f',
] as const;
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe('SweepLostWorkersHandler', () => {
  let runs: InMemoryRunRepository;
  let now: Date;
  let handler: SweepLostWorkersHandler;

  async function claimed(projectId: string) {
    await runs.add({
      projectId,
      provider: 'claude_code',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
    });
    return (await runs.claimNext(WORKER, T0))!;
  }

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    now = T0;
    handler = new SweepLostWorkersHandler(runs, { now: () => now }, { seconds: 60 });
  });

  it('fails a preparing Run whose last heartbeat is older than the lease', async () => {
    const run = await claimed(PROJECTS[0]);
    now = later(61);

    expect(await handler.execute()).toBe(1);

    expect(await runs.findById(run.id)).toMatchObject({
      state: 'failed',
      failure: {
        code: 'worker_lost',
        detail: 'The agent worker sent no heartbeat for 60 seconds.',
      },
      claimedBy: null,
      finishedAt: later(61),
    });
  });

  it('fails a running Run the same way', async () => {
    const run = await claimed(PROJECTS[0]);
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      now: later(30),
    });
    now = later(91);

    expect(await handler.execute()).toBe(1);
    expect((await runs.findById(run.id))?.state).toBe('failed');
  });

  it('keeps a Run whose heartbeat is within the lease', async () => {
    const run = await claimed(PROJECTS[0]);
    await runs.heartbeat(run.id, WORKER, later(50));
    now = later(100);

    expect(await handler.execute()).toBe(0);
    expect((await runs.findById(run.id))?.state).toBe('preparing');
  });

  it('never sweeps a Run waiting for the operator: no worker holds it', async () => {
    const run = await claimed(PROJECTS[0]);
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      now: T0,
    });
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'running',
      to: 'waiting_for_operator',
      failure: null,
      now: T0,
    });
    now = later(3600);

    expect(await handler.execute()).toBe(0);
    expect((await runs.findById(run.id))?.state).toBe('waiting_for_operator');
  });

  it('leaves queued Runs alone', async () => {
    await runs.add({
      projectId: PROJECTS[1],
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
    });
    now = later(3600);

    expect(await handler.execute()).toBe(0);
    expect(runs.runs[0]?.state).toBe('queued');
  });
});
