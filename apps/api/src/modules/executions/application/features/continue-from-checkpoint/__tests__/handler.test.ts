import { beforeEach, describe, expect, it } from 'vitest';
import { Run } from '../../../../domain/entities/run.js';
import { phaseAgent } from '../../../../domain/entities/__tests__/workflow-run-fixtures.js';
import { RunNotAtCheckpointError, RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import type { RunWorkflowData } from '../../../../domain/value-objects/run-workflow.js';
import { Task } from '../../../../domain/value-objects/task.js';
import { SEQUENTIAL_PLANS } from '../../../ports/__tests__/fake-workflow-plans.js';
import { ContinueFromCheckpointHandler } from '../handler.js';

const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const T1 = new Date('2026-11-15T12:30:00.000Z');
const WORKING_COPY = { runBranch: 'studio/run', commits: [], hasUncommittedChanges: true };

const RECORD: RunWorkflowData = {
  name: 'plan-then-build',
  commit: 'c'.repeat(40),
  items: [
    { id: 'plan', kind: 'work', agent: 'planner' },
    { id: 'look', kind: 'checkpoint', text: 'Read the plan.' },
    { id: 'again', kind: 'checkpoint', text: 'Read it twice.' },
    { id: 'build', kind: 'work', agent: 'builder' },
    { id: 'done', kind: 'checkpoint', text: 'Ready?' },
  ],
};

async function startAtFirstCheckpoint(runs: InMemoryRunRepository): Promise<string> {
  const planner = phaseAgent('planner');
  const created = await runs.add(
    Run.start({
      id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
      projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
      provider: planner.provider,
      agent: planner,
      workflow: { record: RECORD, phaseAgents: [planner, phaseAgent('builder')] },
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

describe('ContinueFromCheckpointHandler', () => {
  let runs: InMemoryRunRepository;
  let handler: ContinueFromCheckpointHandler;
  let id: string;

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    handler = new ContinueFromCheckpointHandler(runs, { now: () => T1 }, SEQUENTIAL_PLANS);
    id = await startAtFirstCheckpoint(runs);
  });

  it('moves a Run on to the next Checkpoint when two come in a row, and waits again', async () => {
    await handler.execute({ runId: id, comment: 'a note' });

    const run = (await runs.findById(id))!;
    expect(run.waiting).toMatchObject({ reason: 'checkpoint', checkpoint: { id: 'again' } });
    expect(run.progress.waitingSince).toEqual(T1);
  });

  it('queues the next Phase after the last Checkpoint in a row, with the comments of both', async () => {
    await handler.execute({ runId: id, comment: 'first' });
    await handler.execute({ runId: id, comment: 'second' });

    const run = (await runs.findById(id))!;
    expect(run.lifecycle.state).toBe('queued');
    expect(run.currentPhase).toBe(1);
    expect(run.phasePending).toBe(true);
    expect(run.phases[1]!.checkpointComment).toBe('first\n\nsecond');
  });

  it('ends the Workflow when the Checkpoint is the last item', async () => {
    await handler.execute({ runId: id });
    await handler.execute({ runId: id });
    await runs.change(id, (run) => {
      run.claimBy(WORKER, T1);
      run.reportState(WORKER, { state: 'running', failure: null }, T1);
      run.reportStep(
        WORKER,
        { kind: 'start', index: 2, result: { outcome: 'done', summary: 'built' } },
        WORKING_COPY,
        [],
        T1,
        { kind: 'checkpoint', item: 4 },
      );
    });

    await handler.execute({ runId: id });

    const run = (await runs.findById(id))!;
    expect(run.workflowEnded).toBe(true);
    expect(run.handOut()).toEqual({ kind: 'deliver', runBranch: 'studio/run' });
  });

  it('refuses a second Continue for the same Checkpoint when it names it', async () => {
    await handler.execute({ runId: id, checkpoint: 'look' });

    await expect(handler.execute({ runId: id, checkpoint: 'look' })).rejects.toBeInstanceOf(
      RunNotAtCheckpointError,
    );
    expect((await runs.findById(id))!.waiting).toMatchObject({ checkpoint: { id: 'again' } });
  });

  it('lets only one of two simultaneous requests pass the Checkpoint', async () => {
    const results = await Promise.allSettled([
      handler.execute({ runId: id, checkpoint: 'look' }),
      handler.execute({ runId: id, checkpoint: 'look' }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await runs.findById(id))!.waiting).toMatchObject({ checkpoint: { id: 'again' } });
  });

  it('is refused after the Run was cancelled, and starts nothing', async () => {
    await runs.change(id, (run) => run.cancel(T1));

    await expect(handler.execute({ runId: id })).rejects.toBeInstanceOf(RunNotAtCheckpointError);

    const run = (await runs.findById(id))!;
    expect(run.lifecycle.state).toBe('cancelled');
    expect(run.phasePending).toBe(false);
    expect(run.currentPhase).toBe(0);
  });

  it('refuses an unknown Run, also for an id that is not a UUID', async () => {
    await expect(handler.execute({ runId: 'nope' })).rejects.toBeInstanceOf(RunNotFoundError);
    await expect(
      handler.execute({ runId: '9b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b' }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
