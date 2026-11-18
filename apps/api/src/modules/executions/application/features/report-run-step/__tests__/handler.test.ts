import { beforeEach, describe, expect, it } from 'vitest';
import type { RunSnapshot } from '../../../../domain/entities/run-snapshot.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import {
  RunNotHeldError,
  StepLimitReachedError,
  StepOutOfOrderError,
} from '../../../../domain/repositories/run-repository.js';
import { REDACTED } from '../../../../domain/value-objects/log-redaction.js';
import { ReportRunStepHandler } from '../handler.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';

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
  let run: RunSnapshot;

  const report = async (workerId = WORKER, workingCopy = WORKING_COPY) =>
    (await handler.execute({ runId: run.id, workerId, kind: 'start', result: RESULT, workingCopy }))
      .index;

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    handler = new ReportRunStepHandler(
      runs,
      { now: () => T1 },
      { forRun: () => Promise.resolve(['known-secret-value']) },
    );
    await runs.start({
      projectId: PROJECT,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 2, waitingDays: 14, maxTotalSteps: 50 },
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

  it('never redacts the enum fields, even when a known value equals one (#104, #119 review)', async () => {
    handler = new ReportRunStepHandler(
      runs,
      { now: () => T1 },
      {
        // Environment file values may be any word, e.g. `done` or `passed`.
        forRun: () => Promise.resolve(['done', 'passed', 'needs_input']),
      },
    );
    await running();
    const result = {
      outcome: 'needs_input',
      summary: 'The checks passed; is it done?',
      question: { text: 'Is it done?', options: ['done', 'not yet'], recommendation: 'done' },
      sessionRef: 'session-done',
      checks: [{ name: 'unit', result: 'passed' }],
    };

    await handler.execute({
      runId: run.id,
      workerId: WORKER,
      kind: 'start',
      result,
      workingCopy: WORKING_COPY,
    });

    expect(runs.steps[0]!.step.result).toEqual({
      outcome: 'needs_input',
      summary: `The checks ${REDACTED}; is it ${REDACTED}?`,
      question: {
        text: `Is it ${REDACTED}?`,
        options: [REDACTED, 'not yet'],
        recommendation: REDACTED,
      },
      checks: [{ name: 'unit', result: 'passed' }],
    });
    // The session reference is opaque: kept exactly, on the Run (Issue #103).
    expect((await runs.findById(run.id))?.claim.sessionRef).toBe('session-done');
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
    expect((await runs.findById(run.id))!.snapshot()).toMatchObject({
      state: 'failed',
      failure: {
        code: 'step_limit',
        detail: 'The run reached its limit of 2 run steps; no further step was started.',
      },
      claimedBy: null,
      finishedAt: T1,
    });
  });

  // Issue #103: a question becomes the Run's open question; the session stays internal.
  describe('questions and sessions', () => {
    const asking = {
      outcome: 'needs_input',
      summary: 'Stuck on known-secret-value.',
      question: {
        text: 'Use known-secret-value as the key?',
        options: ['Yes', 'No, known-secret-value is wrong'],
        recommendation: 'Yes',
      },
      sessionRef: 'session-known-secret-value',
    };

    it("stores the question, redacted, as the Run's next message and the session on the Run", async () => {
      await running();

      await handler.execute({
        runId: run.id,
        workerId: WORKER,
        kind: 'start',
        result: asking,
        workingCopy: WORKING_COPY,
      });

      const stored = await runs.findById(run.id);
      expect(stored?.conversation.messages).toEqual([
        {
          kind: 'question',
          question: {
            text: `Use ${REDACTED} as the key?`,
            options: ['Yes', `No, ${REDACTED} is wrong`],
            recommendation: 'Yes',
          },
          at: T1,
        },
      ]);
      // An opaque reference the resume needs exactly: never redacted, never in the stored result.
      expect(stored?.claim.sessionRef).toBe('session-known-secret-value');
      expect(runs.steps[0]!.step.result).toEqual({
        outcome: 'needs_input',
        summary: `Stuck on ${REDACTED}.`,
        question: {
          text: `Use ${REDACTED} as the key?`,
          options: ['Yes', `No, ${REDACTED} is wrong`],
          recommendation: 'Yes',
        },
      });
    });

    it('stores a re-sent step and its question only once', async () => {
      await running();
      const send = () =>
        handler.execute({
          runId: run.id,
          workerId: WORKER,
          index: 1,
          kind: 'start',
          result: asking,
          workingCopy: WORKING_COPY,
        });

      await send();
      await send();

      expect((await runs.findById(run.id))?.conversation.messages).toHaveLength(1);
    });

    it('keeps the session a done step reports, and no message', async () => {
      await running();

      await handler.execute({
        runId: run.id,
        workerId: WORKER,
        kind: 'start',
        result: { ...RESULT, sessionRef: 'session-2' },
        workingCopy: WORKING_COPY,
      });

      expect((await runs.findById(run.id))!.snapshot()).toMatchObject({
        sessionRef: 'session-2',
        messages: [],
      });
    });
  });

  // Review of #121: the worker numbers its steps; a re-sent number is not stored twice.
  describe('step numbers', () => {
    const numbered = async (index: number) =>
      (
        await handler.execute({
          runId: run.id,
          workerId: WORKER,
          index,
          kind: 'start',
          result: RESULT,
          workingCopy: WORKING_COPY,
        })
      ).index;

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
