import { beforeEach, describe, expect, it } from 'vitest';
import { IllegalRunTransitionError, type Run } from '../../../domain/entities/run.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { RunNotFoundError, RunNotHeldError } from '../../../domain/repositories/run-repository.js';
import { ReportRunStateHandler, type ReportRunStateInput } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const UNKNOWN_RUN = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T12:05:00.000Z');

describe('ReportRunStateHandler', () => {
  let runs: InMemoryRunRepository;
  let handler: ReportRunStateHandler;
  let run: Run;
  let notified: string[];

  const report = (input: Partial<ReportRunStateInput>) =>
    handler.execute({ runId: run.id, workerId: WORKER, state: 'running', failure: null, ...input });

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    notified = [];
    handler = new ReportRunStateHandler(
      runs,
      { now: () => T1 },
      { notify: (runId) => notified.push(runId), subscribe: () => () => undefined },
    );
    await runs.add({
      projectId: PROJECT,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      integrationBranch: 'dev',
    });
    run = (await runs.claimNext(WORKER, T0))!;
  });

  it('moves a preparing Run to running, still held', async () => {
    expect(await report({ state: 'running' })).toMatchObject({
      state: 'running',
      claimedBy: WORKER,
      finishedAt: null,
    });
  });

  it('finishes a running Run as succeeded and releases it', async () => {
    await report({ state: 'running' });

    expect(await report({ state: 'succeeded' })).toMatchObject({
      state: 'succeeded',
      claimedBy: null,
      finishedAt: T1,
      failure: null,
    });
  });

  it('wakes the live log streams of the Run on every change, so they can end (Issue #99)', async () => {
    await report({ state: 'running' });
    await report({ state: 'succeeded' });

    expect(notified).toEqual([run.id, run.id]);
  });

  it("records a failed Run's Working copy state with its failure (Issue #98)", async () => {
    await report({ state: 'running' });
    const workingCopy = {
      runBranch: 'agent/x-r0b8e5c2d',
      commits: [{ id: 'c'.repeat(40), subject: 'Half done' }],
      hasUncommittedChanges: true,
    };

    await report({
      state: 'failed',
      failure: { code: 'agent_failed', detail: 'exit 1' },
      workingCopy,
    });

    expect((await runs.findById(run.id))?.workingCopy).toEqual(workingCopy);
  });

  it('keeps the last Working copy state when a failure brings none', async () => {
    await report({ state: 'running' });
    const workingCopy = { runBranch: 'agent/x', commits: [], hasUncommittedChanges: false };
    await runs.appendStep(run.id, WORKER, { kind: 'start', result: {} }, workingCopy, []);

    await report({ state: 'failed', failure: { code: 'unknown', detail: 'x' } });

    expect((await runs.findById(run.id))?.workingCopy).toEqual(workingCopy);
  });

  it('records the failure of a failed Run', async () => {
    const failure = { code: 'agent_failed', detail: 'The agent exited with code 1.' } as const;

    expect(await report({ state: 'failed', failure })).toMatchObject({
      state: 'failed',
      failure,
      finishedAt: T1,
    });
  });

  it('releases a Run that waits for the operator', async () => {
    await report({ state: 'running' });

    expect(await report({ state: 'waiting_for_operator' })).toMatchObject({
      state: 'waiting_for_operator',
      claimedBy: null,
      finishedAt: null,
    });
  });

  it('rejects an illegal transition and changes nothing', async () => {
    await expect(report({ state: 'succeeded' })).rejects.toEqual(
      new IllegalRunTransitionError('preparing', 'succeeded'),
    );
    expect((await runs.findById(run.id))?.state).toBe('preparing');
  });

  it('rejects a report from a worker that does not hold the Run', async () => {
    await expect(report({ workerId: OTHER_WORKER })).rejects.toBeInstanceOf(RunNotHeldError);
  });

  it('rejects a report on a Run the worker released', async () => {
    await report({ state: 'running' });
    await report({ state: 'succeeded' });

    await expect(report({ state: 'running' })).rejects.toBeInstanceOf(RunNotHeldError);
  });

  describe('delivery (Issue #102)', () => {
    const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
    const DELIVERY_FAILED = {
      code: 'delivery_failed',
      detail: 'Pushing the Run branch was refused.',
    } as const;

    it('records the pull request of a delivered Run', async () => {
      await report({ state: 'running' });

      expect(
        await report({
          state: 'succeeded',
          delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
        }),
      ).toMatchObject({ state: 'succeeded', delivery: 'delivered', pullRequest: PULL_REQUEST });
    });

    it('records "No changes" as the delivery none, without a pull request', async () => {
      await report({ state: 'running' });

      expect(await report({ state: 'succeeded', delivery: { outcome: 'none' } })).toMatchObject({
        state: 'succeeded',
        delivery: 'none',
        pullRequest: null,
      });
    });

    it('records a failed delivery as the delivery failed', async () => {
      await report({ state: 'running' });

      expect(await report({ state: 'failed', failure: DELIVERY_FAILED })).toMatchObject({
        state: 'failed',
        failure: DELIVERY_FAILED,
        delivery: 'failed',
      });
    });

    /** A failed delivery whose retry the operator requested and `WORKER` claimed. */
    async function heldRetry() {
      await report({ state: 'running' });
      await report({ state: 'failed', failure: DELIVERY_FAILED });
      await runs.requestDeliveryRetry(run.id);
      expect((await runs.claimNext(WORKER, T1))?.id).toBe(run.id);
    }

    it('turns a failed delivery into succeeded when its retry delivers', async () => {
      await heldRetry();
      const workingCopy = { runBranch: 'agent/x', commits: [], hasUncommittedChanges: false };

      expect(
        await report({
          state: 'succeeded',
          delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
          workingCopy,
        }),
      ).toMatchObject({
        state: 'succeeded',
        failure: null,
        delivery: 'delivered',
        pullRequest: PULL_REQUEST,
        deliveryRequested: false,
        claimedBy: null,
        finishedAt: T1,
        workingCopy,
      });
    });

    it('keeps a Run failed with the new reason when its retry fails again', async () => {
      await heldRetry();
      const again = { code: 'delivery_failed', detail: 'GitHub answered 503.' } as const;

      expect(await report({ state: 'failed', failure: again })).toMatchObject({
        state: 'failed',
        failure: again,
        delivery: 'failed',
        deliveryRequested: false,
        claimedBy: null,
      });
    });

    it('accepts no other outcome of a delivery retry', async () => {
      await heldRetry();

      await expect(report({ state: 'running' })).rejects.toBeInstanceOf(IllegalRunTransitionError);
      await expect(report({ state: 'succeeded' })).rejects.toBeInstanceOf(
        IllegalRunTransitionError,
      );
      await expect(
        report({ state: 'failed', failure: { code: 'agent_failed', detail: 'x' } }),
      ).rejects.toBeInstanceOf(IllegalRunTransitionError);
      expect((await runs.findById(run.id))?.claimedBy).toBe(WORKER);
    });

    it('rejects a delivery outcome from a worker that does not hold the retry', async () => {
      await heldRetry();

      await expect(
        report({ workerId: OTHER_WORKER, state: 'succeeded', delivery: { outcome: 'none' } }),
      ).rejects.toBeInstanceOf(RunNotHeldError);
    });
  });

  it('rejects an unknown Run, also an id that is not a UUID', async () => {
    await expect(report({ runId: UNKNOWN_RUN })).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(report({ runId: 'nope' })).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
