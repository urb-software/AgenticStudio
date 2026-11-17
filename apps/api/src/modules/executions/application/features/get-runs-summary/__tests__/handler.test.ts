import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { GetRunsSummaryHandler } from '../handler.js';

// Issue #115: the top-bar run indicator reads two counts instead of every Run.
const PROJECTS = [
  '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
  '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f',
  '5b4d0e3a-6f7c-4d8e-9fa0-1b2c3d4e5f6a',
];
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-16T12:00:00.000Z');

describe('GetRunsSummaryHandler', () => {
  let runs: InMemoryRunRepository;
  let handler: GetRunsSummaryHandler;

  const add = (projectId: string) =>
    runs.add({
      projectId,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      integrationBranch: 'dev',
    });

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    handler = new GetRunsSummaryHandler(runs);
  });

  it('counts nothing when there are no Runs', async () => {
    expect(await handler.execute()).toEqual({ running: 0, waiting: 0 });
  });

  it('counts queued, preparing and running Runs as running, and waiting ones apart', async () => {
    await add(PROJECTS[0]!);
    await add(PROJECTS[1]!);
    await add(PROJECTS[2]!);
    // Two are claimed (the server's limit): one stays preparing, one goes running.
    await runs.claimNext(WORKER, T0);
    const running = await runs.claimNext(WORKER, T0);
    await runs.transitionClaimed({
      runId: running!.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      cancelRequested: false,
      now: T0,
    });

    expect(await handler.execute()).toEqual({ running: 3, waiting: 0 });
  });

  it('counts a Run waiting for the operator as waiting and leaves finished Runs out', async () => {
    const waiting = await add(PROJECTS[0]!);
    const finished = await add(PROJECTS[1]!);
    await runs.claimNext(WORKER, T0);
    await runs.claimNext(WORKER, T0);
    await runs.transitionClaimed({
      runId: waiting.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      cancelRequested: false,
      now: T0,
    });
    await runs.transitionClaimed({
      runId: waiting.id,
      workerId: WORKER,
      from: 'running',
      to: 'waiting_for_operator',
      failure: null,
      cancelRequested: false,
      now: T0,
    });
    await runs.transitionClaimed({
      runId: finished.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'failed',
      failure: { code: 'preparation_failed', detail: 'x' },
      cancelRequested: false,
      now: T0,
    });

    expect(await handler.execute()).toEqual({ running: 0, waiting: 1 });
  });
});
