import { beforeEach, describe, expect, it } from 'vitest';
import { Run } from '../../../../domain/entities/run.js';
import { phaseAgent } from '../../../../domain/entities/__tests__/workflow-run-fixtures.js';
import { RunNotAtCheckpointError, RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { Task } from '../../../../domain/value-objects/task.js';
import { StopAtCheckpointHandler } from '../handler.js';

const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T12:30:00.000Z');
const WORKING_COPY = { runBranch: 'studio/run', commits: [], hasUncommittedChanges: true };

async function startAtCheckpoint(runs: InMemoryRunRepository): Promise<string> {
  const planner = phaseAgent('planner');
  const created = await runs.add(
    Run.start({
      id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
      projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
      provider: planner.provider,
      agent: planner,
      workflow: {
        record: {
          name: 'plan-then-build',
          commit: 'c'.repeat(40),
          items: [
            { id: 'plan', kind: 'work', agent: 'planner' },
            { id: 'look', kind: 'checkpoint', text: 'Read the plan.' },
            { id: 'build', kind: 'work', agent: 'builder' },
          ],
        },
        phaseAgents: [planner, phaseAgent('builder')],
      },
      task: Task.of('Add a health check'),
      startCommit: 'a'.repeat(40),
      remoteUrl: 'https://git.example.test/a.git',
      integrationBranch: 'dev',
      limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 },
      now: T0,
    }),
  );
  const claimed = (await runs.claimNext(WORKER, T0))!;
  await runs.change(claimed.id, (run) => {
    run.reportState(WORKER, { state: 'running', failure: null }, T0);
    run.reportStep(
      WORKER,
      { kind: 'start', index: 1, result: { outcome: 'done', summary: 'planned' }, sessionRef: 's' },
      WORKING_COPY,
      [],
      T0,
      { kind: 'checkpoint', item: 1 },
    );
  });
  return created.id;
}

describe('StopAtCheckpointHandler', () => {
  let runs: InMemoryRunRepository;
  let handler: StopAtCheckpointHandler;
  let id: string;

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    handler = new StopAtCheckpointHandler(runs, { now: () => T1 });
    id = await startAtCheckpoint(runs);
  });

  it('ends the Workflow and queues the delivery of what exists to the worker with the Working copy', async () => {
    await handler.execute({ runId: id, checkpoint: 'look' });

    const run = (await runs.findById(id))!;
    expect(run.lifecycle.state).toBe('queued');
    expect(run.workflowEnded).toBe(true);
    expect(run.currentPhase).toBe(0);
    expect(run.handOut()).toEqual({ kind: 'deliver', runBranch: 'studio/run' });
    expect((await runs.claimNext(WORKER, T1))?.id).toBe(id);
  });

  it('is refused the second time, and after a cancel', async () => {
    await handler.execute({ runId: id });
    await expect(handler.execute({ runId: id })).rejects.toBeInstanceOf(RunNotAtCheckpointError);

    const other = new InMemoryRunRepository();
    const otherHandler = new StopAtCheckpointHandler(other, { now: () => T1 });
    const cancelled = await startAtCheckpoint(other);
    await other.change(cancelled, (run) => run.cancel(T1));
    await expect(otherHandler.execute({ runId: cancelled })).rejects.toBeInstanceOf(
      RunNotAtCheckpointError,
    );
  });

  it('refuses a Checkpoint the operator did not see', async () => {
    await expect(handler.execute({ runId: id, checkpoint: 'elsewhere' })).rejects.toBeInstanceOf(
      RunNotAtCheckpointError,
    );
    expect((await runs.findById(id))!.lifecycle.state).toBe('waiting_for_operator');
  });

  it('refuses an unknown Run', async () => {
    await expect(handler.execute({ runId: 'nope' })).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
