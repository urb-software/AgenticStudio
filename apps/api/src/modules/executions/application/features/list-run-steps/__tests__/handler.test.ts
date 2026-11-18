import { describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { REDACTED } from '../../../../domain/value-objects/log-redaction.js';
import { ListRunStepsHandler } from '../handler.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');

describe('ListRunStepsHandler (Issue #99)', () => {
  it('shows each step result: outcome, summary and checks, redacted like the log', async () => {
    const runs = new InMemoryRunRepository();
    await runs.start({
      projectId: PROJECT,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      integrationBranch: 'dev',
    });
    const run = (await runs.claimNext(WORKER, T0))!;
    await runs.transitionClaimed({
      runId: run.id,
      workerId: WORKER,
      from: 'preparing',
      to: 'running',
      failure: null,
      cancelRequested: false,
      now: T0,
    });
    await runs.appendStep(
      run.id,
      WORKER,
      {
        kind: 'start',
        result: {
          outcome: 'done',
          summary: 'Used test-secret-value to log in.',
          pullRequest: { title: 'T', body: 'B' },
          checks: [
            { name: 'unit tests', result: 'passed' },
            { name: 'lint', result: 'failed', detail: 'see test-secret-value' },
          ],
        },
      },
      { runBranch: 'agent/x', commits: [], hasUncommittedChanges: false },
      ['lint'],
      T0,
    );
    const handler = new ListRunStepsHandler(runs, {
      forRun: () => Promise.resolve(['test-secret-value']),
    });

    expect(await handler.execute({ runId: run.id })).toEqual([
      {
        index: 1,
        kind: 'start',
        outcome: 'done',
        summary: `Used ${REDACTED} to log in.`,
        checks: [
          { name: 'unit tests', result: 'passed' },
          { name: 'lint', result: 'failed', detail: `see ${REDACTED}` },
        ],
        reportedAt: expect.any(Date),
      },
    ]);
  });

  it('rejects an unknown Run', async () => {
    const handler = new ListRunStepsHandler(new InMemoryRunRepository(), {
      forRun: () => Promise.resolve([]),
    });
    await expect(handler.execute({ runId: 'nope' })).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
