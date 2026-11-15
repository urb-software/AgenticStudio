import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { ClaimRunHandler } from '../handler.js';

// Issue #96: handing out work under the concurrency limits, after the lost-worker sweep.
const [A, B, C] = [
  '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
  '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f',
  '5b4d0e3a-6f7c-4d8e-9fa0-1b2c3d4e5f6a',
] as const;
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const T0 = new Date('2026-11-15T12:00:00.000Z');

describe('ClaimRunHandler', () => {
  let runs: InMemoryRunRepository;
  let now: Date;
  let handler: ClaimRunHandler;

  const queue = (projectId: string) =>
    runs.add({
      projectId,
      provider: 'claude_code',
      task: `Task of ${projectId}`,
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      integrationBranch: 'dev',
    });

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    now = T0;
    handler = new ClaimRunHandler(runs, { now: () => now }, { seconds: 60 });
  });

  it('hands out nothing when no Run is queued', async () => {
    expect(await handler.execute(WORKER)).toBeNull();
  });

  it('hands out the oldest queued Run as preparing, held by the worker', async () => {
    const first = await queue(A);
    await queue(B);

    const claimed = await handler.execute(WORKER);

    expect(claimed).toMatchObject({
      id: first.id,
      state: 'preparing',
      claimedBy: WORKER,
      startedAt: T0,
    });
  });

  it('keeps one active Run per project and two across the server; the rest wait in order', async () => {
    const a1 = await queue(A);
    const a2 = await queue(A);
    const b1 = await queue(B);
    const c1 = await queue(C);

    expect((await handler.execute(WORKER))?.id).toBe(a1.id);
    expect((await handler.execute(OTHER_WORKER))?.id).toBe(b1.id);
    expect(await handler.execute(WORKER)).toBeNull();

    expect((await runs.findById(a2.id))?.state).toBe('queued');
    expect((await runs.findById(c1.id))?.state).toBe('queued');
  });

  it('fails a Run without a remote URL as preparation_failed and hands out the next (review of #117)', async () => {
    const orphan = await runs.add({
      projectId: A,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: '',
      integrationBranch: '',
    });
    const next = await queue(B);

    const claimed = await handler.execute(WORKER);

    expect(claimed?.id).toBe(next.id);
    expect(await runs.findById(orphan.id)).toMatchObject({
      state: 'failed',
      failure: { code: 'preparation_failed' },
      claimedBy: null,
    });
  });

  describe('delivery retries (Issue #102)', () => {
    /** A Run of `projectId` whose delivery failed, released by its worker. */
    async function failedDelivery(projectId: string) {
      const run = await queue(projectId);
      await runs.claimNext(OTHER_WORKER, T0);
      for (const [from, to] of [
        ['preparing', 'running'],
        ['running', 'failed'],
      ] as const) {
        await runs.transitionClaimed({
          runId: run.id,
          workerId: OTHER_WORKER,
          from,
          to,
          failure: to === 'failed' ? { code: 'delivery_failed', detail: 'refused' } : null,
          now: T0,
        });
      }
      return run;
    }

    it('hands out a requested delivery retry, still failed, held by the worker', async () => {
      const run = await failedDelivery(A);
      await runs.requestDeliveryRetry(run.id);

      expect(await handler.execute(WORKER)).toMatchObject({
        id: run.id,
        state: 'failed',
        deliveryRequested: true,
        claimedBy: WORKER,
      });
      // Held: handed out once.
      expect(await handler.execute(OTHER_WORKER)).toBeNull();
    });

    it('hands out no failed delivery whose retry was not requested', async () => {
      await failedDelivery(A);

      expect(await handler.execute(WORKER)).toBeNull();
    });

    it('counts a held delivery retry toward the limits', async () => {
      const retry = await failedDelivery(A);
      await runs.requestDeliveryRetry(retry.id);
      await handler.execute(WORKER);
      const a2 = await queue(A);
      const b1 = await queue(B);
      const c1 = await queue(C);

      expect((await handler.execute(WORKER))?.id).toBe(b1.id);
      expect(await handler.execute(WORKER)).toBeNull();
      expect((await runs.findById(a2.id))?.state).toBe('queued');
      expect((await runs.findById(c1.id))?.state).toBe('queued');
    });

    it('keeps a retry whose worker was lost a failed delivery, so it can be retried again', async () => {
      const run = await failedDelivery(A);
      await runs.requestDeliveryRetry(run.id);
      await handler.execute(WORKER);
      now = new Date(T0.getTime() + 61_000);

      await handler.execute(OTHER_WORKER);

      expect(await runs.findById(run.id)).toMatchObject({
        state: 'failed',
        failure: {
          code: 'delivery_failed',
          detail: expect.stringContaining('retried the delivery'),
        },
        delivery: 'failed',
        deliveryRequested: false,
        claimedBy: null,
      });
    });
  });

  it('sweeps lost workers first, which frees their places', async () => {
    const a1 = await queue(A);
    const b1 = await queue(B);
    const c1 = await queue(C);
    await handler.execute(WORKER);
    await handler.execute(WORKER);
    now = new Date(T0.getTime() + 61_000);

    const claimed = await handler.execute(OTHER_WORKER);

    expect(claimed?.id).toBe(c1.id);
    expect((await runs.findById(a1.id))?.failure?.code).toBe('worker_lost');
    expect((await runs.findById(b1.id))?.failure?.code).toBe('worker_lost');
  });
});
