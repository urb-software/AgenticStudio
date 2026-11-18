import { beforeEach, describe, expect, it } from 'vitest';
import {
  DeliveryNotRetryableError,
  RunNotFoundError,
} from '../../../../domain/errors/run-errors.js';
import { type RunSnapshot } from '../../../../domain/entities/run-snapshot.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { RetryDeliveryHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const UNKNOWN_RUN = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const T0 = new Date('2026-11-15T12:00:00.000Z');

describe('RetryDeliveryHandler', () => {
  let runs: InMemoryRunRepository;
  let handler: RetryDeliveryHandler;
  let run: RunSnapshot;

  async function fail(code: 'delivery_failed' | 'agent_failed') {
    await runs.claimNext(WORKER, T0);
    for (const [from, to] of [
      ['preparing', 'running'],
      ['running', 'failed'],
    ] as const) {
      await runs.transitionClaimed({
        runId: run.id,
        workerId: WORKER,
        from,
        to,
        failure: to === 'failed' ? { code, detail: 'x' } : null,
        cancelRequested: false,
        now: T0,
      });
    }
  }

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    handler = new RetryDeliveryHandler(runs);
    run = (
      await runs.start({
        projectId: PROJECT,
        provider: 'codex',
        task: 'x',
        startCommit: 'a',
        remoteUrl: 'https://github.com/acme/shop.git',
        limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
        integrationBranch: 'dev',
      })
    ).snapshot();
  });

  it('requests a retry of a failed delivery; the Run stays failed until a worker delivers', async () => {
    await fail('delivery_failed');

    expect(await handler.execute({ runId: run.id })).toBeUndefined();

    expect((await runs.findById(run.id))?.snapshot()).toMatchObject({
      state: 'failed',
      failure: { code: 'delivery_failed' },
      deliveryRequested: true,
    });
  });

  it('accepts a repeated request while the retry is pending', async () => {
    await fail('delivery_failed');
    await handler.execute({ runId: run.id });

    await handler.execute({ runId: run.id });

    expect((await runs.findById(run.id))?.snapshot().deliveryRequested).toBe(true);
  });

  it('refuses any Run whose delivery did not fail', async () => {
    await expect(handler.execute({ runId: run.id })).rejects.toBeInstanceOf(
      DeliveryNotRetryableError,
    );
    await fail('agent_failed');
    await expect(handler.execute({ runId: run.id })).rejects.toBeInstanceOf(
      DeliveryNotRetryableError,
    );
    expect((await runs.findById(run.id))?.delivery.requested).toBe(false);
  });

  it('refuses an unknown Run, also an id that is not a UUID', async () => {
    await expect(handler.execute({ runId: UNKNOWN_RUN })).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(handler.execute({ runId: 'nope' })).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
