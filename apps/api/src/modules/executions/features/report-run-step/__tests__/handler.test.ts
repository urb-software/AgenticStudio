import { beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '../../../domain/entities/run.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { RunNotFoundError, RunNotHeldError } from '../../../domain/repositories/run-repository.js';
import { ReportRunStepHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const RESULT = { outcome: 'done', summary: 'Done.' };

describe('ReportRunStepHandler', () => {
  let runs: InMemoryRunRepository;
  let handler: ReportRunStepHandler;
  let run: Run;

  const report = (workerId = WORKER) =>
    handler.execute({ runId: run.id, workerId, kind: 'start', result: RESULT });

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    handler = new ReportRunStepHandler(runs);
    await runs.add({ projectId: PROJECT, provider: 'codex', task: 'x', startCommit: 'a' });
    run = (await runs.claimNext(WORKER, T0))!;
  });

  async function running() {
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      now: T0,
    });
  }

  it('stores the steps of a running Run, numbered in report order', async () => {
    await running();

    expect(await report()).toBe(1);
    expect(await report()).toBe(2);
    expect(runs.steps).toEqual([
      { runId: run.id, index: 1, step: { kind: 'start', result: RESULT } },
      { runId: run.id, index: 2, step: { kind: 'start', result: RESULT } },
    ]);
  });

  it('rejects a step before the Run is running', async () => {
    await expect(report()).rejects.toBeInstanceOf(RunNotHeldError);
  });

  it('rejects a step from a worker that does not hold the Run', async () => {
    await running();

    await expect(report(OTHER_WORKER)).rejects.toBeInstanceOf(RunNotHeldError);
    expect(runs.steps).toEqual([]);
  });

  it('rejects an unknown Run', async () => {
    await expect(
      handler.execute({ runId: 'nope', workerId: WORKER, kind: 'start', result: RESULT }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
