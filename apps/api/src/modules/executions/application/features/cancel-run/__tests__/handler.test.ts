import { beforeEach, describe, expect, it } from 'vitest';
import {
  RunAlreadyFinishedError,
  RunNotFoundError,
} from '../../../../domain/value-objects/run-errors.js';
import { type RunSnapshot } from '../../../../domain/value-objects/run-snapshot.js';
import { InMemoryPreparedFollowUpRepository } from '../../../../domain/repositories/__tests__/in-memory-prepared-follow-up-repository.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { CancelRunHandler } from '../handler.js';

// Issue #100: the operator cancels a Run. Unheld Runs (queued, waiting) are cancelled at once;
// held Runs (preparing, running) get a cancel request the worker confirms.
const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const UNKNOWN_RUN = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T12:05:00.000Z');
const T2 = new Date('2026-11-15T12:06:00.000Z');
const LIMITS = { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 };

describe('CancelRunHandler', () => {
  let runs: InMemoryRunRepository;
  let now: Date;
  let handler: CancelRunHandler;
  let run: RunSnapshot;

  const transition = (from: RunSnapshot['state'], to: RunSnapshot['state']) =>
    runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from,
      to,
      failure: to === 'failed' ? { code: 'unknown', detail: 'x' } : null,
      cancelRequested: false,
      now: T0,
    });

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    now = T1;
    handler = new CancelRunHandler(runs, new InMemoryPreparedFollowUpRepository(runs), {
      now: () => now,
    });
    run = (
      await runs.start({
        projectId: PROJECT,
        provider: 'codex',
        task: 'x',
        startCommit: 'a',
        remoteUrl: 'https://git.example.test/a.git',
        integrationBranch: 'dev',
        limits: LIMITS,
      })
    ).snapshot();
  });

  it('cancels a queued Run at once, by the operator', async () => {
    expect((await handler.execute({ runId: run.id })).run).toMatchObject({
      state: 'cancelled',
      cancellation: { by: 'operator', reason: 'Cancelled by the operator.' },
      finishedAt: T1,
    });
  });

  it('cancels a Run waiting for the operator at once', async () => {
    await runs.claimNext(WORKER, T0);
    await transition('preparing', 'running');
    await transition('running', 'waiting_for_operator');

    expect((await handler.execute({ runId: run.id })).run).toMatchObject({
      state: 'cancelled',
      cancellation: { by: 'operator' },
      finishedAt: T1,
      waitingSince: null,
    });
  });

  it.each(['preparing', 'running'] as const)(
    'records a cancel request on a %s Run and leaves its state to the worker',
    async (state) => {
      await runs.claimNext(WORKER, T0);
      if (state === 'running') await transition('preparing', 'running');

      expect((await handler.execute({ runId: run.id })).run).toMatchObject({
        state,
        cancelRequestedAt: T1,
        claimedBy: WORKER,
        cancellation: null,
      });
    },
  );

  it('accepts a repeated cancel and keeps the first request time', async () => {
    await runs.claimNext(WORKER, T0);
    await handler.execute({ runId: run.id });
    now = T2;

    expect((await handler.execute({ runId: run.id })).run).toMatchObject({
      state: 'preparing',
      cancelRequestedAt: T1,
    });
  });

  it('refuses to cancel a finished Run, naming its state', async () => {
    await handler.execute({ runId: run.id });
    now = T2;

    const error = await handler.execute({ runId: run.id }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RunAlreadyFinishedError);
    expect((error as RunAlreadyFinishedError).state).toBe('cancelled');
    expect((await runs.findById(run.id))?.lifecycle.finishedAt).toEqual(T1);
  });

  it('reports an unknown Run, and an id that is not a UUID, as not found', async () => {
    await expect(handler.execute({ runId: UNKNOWN_RUN })).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(handler.execute({ runId: '../etc' })).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
