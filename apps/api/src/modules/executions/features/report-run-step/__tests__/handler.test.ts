import { beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '../../../domain/entities/run.js';
import { InMemoryRunRepository } from '../../../domain/repositories/__tests__/in-memory-run-repository.js';
import {
  RunNotFoundError,
  RunNotHeldError,
  StepLimitReachedError,
  StepOutOfOrderError,
} from '../../../domain/repositories/run-repository.js';
import { REDACTED } from '../../../domain/services/log-redaction.js';
import { ReportRunStepHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T12:30:00.000Z');
const RESULT = { outcome: 'done', summary: 'Done.' };
const WORKING_COPY = {
  runBranch: 'agent/x-r0b8e5c2d',
  commits: [{ id: 'c'.repeat(40), subject: 'Add x' }],
  hasUncommittedChanges: false,
};

describe('ReportRunStepHandler', () => {
  let runs: InMemoryRunRepository;
  let handler: ReportRunStepHandler;
  let run: Run;

  const report = (workerId = WORKER, workingCopy = WORKING_COPY) =>
    handler.execute({ runId: run.id, workerId, kind: 'start', result: RESULT, workingCopy });

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    handler = new ReportRunStepHandler(
      runs,
      { now: () => T1 },
      { forRun: () => Promise.resolve(['known-secret-value']) },
    );
    await runs.add({
      projectId: PROJECT,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 2, waitingDays: 14 },
      integrationBranch: 'dev',
    });
    run = (await runs.claimNext(WORKER, T0))!;
  });

  async function running() {
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      cancelRequested: false,
      now: T0,
    });
  }

  it('redacts every string of the result before storing it (Issue #99)', async () => {
    await running();
    const result = {
      outcome: 'done',
      summary: 'Logged in with known-secret-value.',
      pullRequest: { title: 'Fix', body: 'Token: Bearer abc.def' },
      checks: [{ name: 'login', result: 'passed', detail: 'used known-secret-value' }],
    };

    await handler.execute({
      runId: run.id,
      workerId: WORKER,
      kind: 'start',
      result,
      workingCopy: WORKING_COPY,
    });

    expect(runs.steps[0]!.step.result).toEqual({
      outcome: 'done',
      summary: `Logged in with ${REDACTED}.`,
      pullRequest: { title: 'Fix', body: `Token: Bearer ${REDACTED}` },
      checks: [{ name: 'login', result: 'passed', detail: `used ${REDACTED}` }],
    });
  });

  it('stores the steps of a running Run, numbered in report order', async () => {
    await running();

    expect(await report()).toBe(1);
    expect(await report()).toBe(2);
    expect(runs.steps).toEqual([
      { runId: run.id, index: 1, step: { kind: 'start', result: RESULT } },
      { runId: run.id, index: 2, step: { kind: 'start', result: RESULT } },
    ]);
  });

  it('keeps the latest reported Working copy state on the Run (Issue #98)', async () => {
    await running();
    expect((await runs.findById(run.id))?.workingCopy).toBeNull();

    await report();
    expect((await runs.findById(run.id))?.workingCopy).toEqual(WORKING_COPY);

    const later = { ...WORKING_COPY, commits: [], hasUncommittedChanges: true };
    await report(WORKER, later);
    expect((await runs.findById(run.id))?.workingCopy).toEqual(later);
  });

  it('leaves the Working copy state alone when the step is rejected', async () => {
    await running();
    await report();

    await expect(
      report(OTHER_WORKER, { ...WORKING_COPY, runBranch: 'agent/other' }),
    ).rejects.toBeInstanceOf(RunNotHeldError);
    expect((await runs.findById(run.id))?.workingCopy).toEqual(WORKING_COPY);
  });

  it('records the checks the agent reported failed in the latest step (Issue #102)', async () => {
    await running();
    const checks = [
      { name: 'lint', result: 'passed' },
      { name: 'unit tests', result: 'failed' },
      { name: 'e2e', result: 'not_run' },
    ];

    await handler.execute({
      runId: run.id,
      workerId: WORKER,
      kind: 'start',
      result: { ...RESULT, checks },
      workingCopy: WORKING_COPY,
    });
    expect((await runs.findById(run.id))?.failingChecks).toEqual(['unit tests']);

    await report();
    expect((await runs.findById(run.id))?.failingChecks).toEqual([]);
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
      handler.execute({
        runId: 'nope',
        workerId: WORKER,
        kind: 'start',
        result: RESULT,
        workingCopy: WORKING_COPY,
      }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });

  // Issue #100: the API enforces the step limit too.
  it('refuses a step beyond the maximum and fails the Run with step_limit', async () => {
    await running();
    await report();
    await report();

    await expect(report()).rejects.toBeInstanceOf(StepLimitReachedError);

    expect(runs.steps).toHaveLength(2);
    expect(await runs.findById(run.id)).toMatchObject({
      state: 'failed',
      failure: {
        code: 'step_limit',
        detail: 'The run reached its limit of 2 run steps; no further step was started.',
      },
      claimedBy: null,
      finishedAt: T1,
    });
  });

  // Review of #121: the worker numbers its steps; a re-sent number is not stored twice.
  describe('step numbers', () => {
    const numbered = (index: number) =>
      handler.execute({
        runId: run.id,
        workerId: WORKER,
        index,
        kind: 'start',
        result: RESULT,
        workingCopy: WORKING_COPY,
      });

    it('acknowledges a re-sent step without storing it again', async () => {
      await running();

      expect(await numbered(1)).toBe(1);
      expect(await numbered(1)).toBe(1);
      expect(runs.steps).toHaveLength(1);
    });

    it('refuses a step number that skips ahead', async () => {
      await running();

      const error = await numbered(2).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(StepOutOfOrderError);
      expect((error as StepOutOfOrderError).expected).toBe(1);
      expect(runs.steps).toEqual([]);
    });
  });
});
