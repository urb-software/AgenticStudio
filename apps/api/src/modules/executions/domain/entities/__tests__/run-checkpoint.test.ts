import { describe, expect, it } from 'vitest';
import { RunNotAtCheckpointError, RunNotHeldError } from '../../errors/run-errors.js';
import { HandOutRule } from '../../value-objects/hand-out-rule.js';
import type { RunWorkflowData } from '../../value-objects/run-workflow.js';
import { Task } from '../../value-objects/task.js';
import { Run } from '../run.js';
import { phaseAgent, WORKFLOW_COMMIT } from './workflow-run-fixtures.js';

const AT = new Date('2026-11-15T12:00:00.000Z');
const LATER = new Date('2026-11-16T12:00:00.000Z');
const WORKER = '7d1f3a5c-9e2b-4c6d-8a0e-1b3d5f7a9c2e';
const OTHER_WORKER = '5b9d3f1a-2c4e-4a6b-8d0f-7e9a1c3b5d2f';

const WORKING_COPY = { runBranch: 'studio/run', commits: [], hasUncommittedChanges: true };

/** Phase, Checkpoint, Phase, Checkpoint, Checkpoint, Phase, Checkpoint. */
const RECORD: RunWorkflowData = {
  name: 'plan-then-build',
  commit: WORKFLOW_COMMIT,
  items: [
    { id: 'plan', kind: 'work', agent: 'planner' },
    { id: 'look', kind: 'checkpoint', text: 'Read the plan.' },
    { id: 'build', kind: 'work', agent: 'builder' },
    { id: 'first-look', kind: 'checkpoint', text: 'Check the build.' },
    { id: 'second-look', kind: 'checkpoint', text: 'Check it again.' },
    { id: 'finish', kind: 'work', agent: 'finisher' },
    { id: 'last-look', kind: 'checkpoint', text: 'Ready to deliver?' },
  ],
};

function start(record: RunWorkflowData = RECORD): Run {
  const agents = record.items.flatMap((item) =>
    item.kind === 'checkpoint' ? [] : [phaseAgent(item.agent)],
  );
  return Run.start({
    id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
    projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
    provider: agents[0]!.provider,
    agent: agents[0]!,
    workflow: {
      record,
      phaseAgents: agents,
    },
    task: Task.of('Add a health check'),
    startCommit: 'a'.repeat(40),
    remoteUrl: 'https://git.example.test/a.git',
    integrationBranch: 'dev',
    limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 },
    now: AT,
  });
}

function running(run: Run, at = AT): Run {
  run.claimBy(WORKER, at);
  run.reportState(WORKER, { state: 'running', failure: null }, at);
  return run;
}

function finishStep(run: Run, index: number, next: Parameters<Run['reportStep']>[5]): void {
  run.reportStep(
    WORKER,
    {
      kind: 'start',
      index,
      result: { outcome: 'done', summary: `report ${index}` },
      sessionRef: `session-${index}`,
    },
    WORKING_COPY,
    [],
    AT,
    next,
  );
}

function askQuestion(run: Run): void {
  run.reportStep(
    WORKER,
    {
      kind: 'start',
      index: 1,
      result: { outcome: 'needs_input', summary: 's' },
      question: { text: 'Which one?' },
      sessionRef: 's',
    },
    WORKING_COPY,
    [],
    AT,
  );
  run.reportState(WORKER, { state: 'waiting_for_operator', failure: null }, AT);
}

/** A Run waiting at the Checkpoint "look", after the first Phase. */
function atFirstCheckpoint(): Run {
  const run = running(start());
  finishStep(run, 1, { kind: 'checkpoint', item: 1 });
  return run;
}

/** A Run waiting at "first-look", after the second Phase. */
function atSecondPhaseCheckpoint(): Run {
  const run = atFirstCheckpoint();
  run.continueFromCheckpoint({ kind: 'phase', position: 1 }, undefined, LATER);
  running(run, LATER);
  finishStep(run, 2, { kind: 'checkpoint', item: 3 });
  return run;
}

describe('a Run reaching a Checkpoint', () => {
  it('waits for the operator, with the Checkpoint it waits at, once the Phase before it is done', () => {
    const run = atFirstCheckpoint();

    expect(run.lifecycle.state).toBe('waiting_for_operator');
    expect(run.progress.waitingSince).toEqual(AT);
    expect(run.claim.claimedBy).toBeNull();
    expect(run.claim.releasedBy).toBe(WORKER);
    expect(run.currentPhase).toBe(0);
    expect(run.phasePending).toBe(false);
    expect(run.waiting).toEqual({
      reason: 'checkpoint',
      checkpoint: { id: 'look', text: 'Read the plan.' },
    });
    expect(run.openQuestion).toBeNull();
    expect(run.phases[0]).toMatchObject({
      state: 'done',
      summary: 'report 1',
      sessionRef: 'session-1',
    });
  });

  it('records the waiting state and the place of the Checkpoint in one change', () => {
    const { fields } = atFirstCheckpoint().pendingChanges();

    expect(fields).toMatchObject({
      state: 'waiting_for_operator',
      checkpointItem: 1,
      waitingSince: AT,
      claimedBy: null,
    });
  });

  it('holds its place and keeps the Working copy like a Run waiting for an Answer', () => {
    const run = atFirstCheckpoint();

    expect(HandOutRule.countingPlaces().holdsPlace(run.handOutView())).toBe(true);
    expect(HandOutRule.for(WORKER).takes(run.handOutView())).toBe(false);
    expect(run.workingCopy).toMatchObject({ runBranch: 'studio/run' });
  });

  it('ends cancelled, not waiting, when the operator asked to cancel while the Phase ended', () => {
    const run = running(start());
    run.cancel(AT);

    finishStep(run, 1, { kind: 'checkpoint', item: 1 });

    expect(run.lifecycle.state).toBe('cancelled');
    expect(run.waiting).toBeNull();
  });

  it('shows a Question as its waiting reason when the Run waits for an Answer', () => {
    const run = running(start());
    askQuestion(run);

    expect(run.waiting).toEqual({ reason: 'question' });
    expect(run.pendingChanges().fields.checkpointItem).toBeUndefined();
  });

  it('cannot be answered, and a worker cannot report the Run', () => {
    const run = atFirstCheckpoint();

    expect(() => run.answer('go on', AT)).toThrow();
    expect(() => run.reportState(WORKER, { state: 'running', failure: null }, AT)).toThrow(
      RunNotHeldError,
    );
    expect(() => run.reportState(OTHER_WORKER, { state: 'succeeded', failure: null }, AT)).toThrow(
      RunNotHeldError,
    );
    expect(run.lifecycle.state).toBe('waiting_for_operator');
  });
});

describe('continuing at a Checkpoint', () => {
  it('queues the next Phase as a claim for the worker that holds the Working copy', () => {
    const run = atFirstCheckpoint();

    run.continueFromCheckpoint({ kind: 'phase', position: 1 }, undefined, LATER);

    expect(run.lifecycle.state).toBe('queued');
    expect(run.waiting).toBeNull();
    expect(run.progress.waitingSince).toBeNull();
    expect(run.phasePending).toBe(true);
    expect(run.currentPhase).toBe(1);
    expect(run.agent.name).toBe('builder');
    expect(run.claim.sessionRef).toBeNull();
    expect(run.progress.stepsBeforePart).toBe(1);
    expect(HandOutRule.for(WORKER).takes(run.handOutView())).toBe(true);
    expect(HandOutRule.for(OTHER_WORKER).takes(run.handOutView())).toBe(false);
    expect(run.handOut()).toEqual({ kind: 'next_phase', runBranch: 'studio/run' });
    expect(run.pendingChanges().fields).toMatchObject({
      state: 'queued',
      checkpointItem: null,
      currentPhase: 1,
      phasePending: true,
    });
  });

  it('keeps the comment with the Phase it reaches, and nothing without one', () => {
    const run = atFirstCheckpoint();

    run.continueFromCheckpoint({ kind: 'phase', position: 1 }, 'Use the small plan.', LATER);

    expect(run.phases[1]!.checkpointComment).toBe('Use the small plan.');
    expect(run.phases[0]!.checkpointComment).toBeNull();
    expect(run.pendingChanges().fields.phaseUpdates?.[1]).toMatchObject({
      checkpointComment: 'Use the small plan.',
    });
    const bare = atFirstCheckpoint();
    bare.continueFromCheckpoint({ kind: 'phase', position: 1 }, undefined, LATER);
    expect(bare.phases[1]!.checkpointComment).toBeNull();
  });

  it('is refused the second time, and starts nothing', () => {
    const run = atFirstCheckpoint();
    run.continueFromCheckpoint({ kind: 'phase', position: 1 }, undefined, LATER);
    const before = run.pendingChanges();

    expect(() =>
      run.continueFromCheckpoint({ kind: 'phase', position: 1 }, undefined, LATER),
    ).toThrow(RunNotAtCheckpointError);
    expect(run.currentPhase).toBe(1);
    expect(run.pendingChanges()).toEqual(before);
  });

  it('is refused after the Run was cancelled', () => {
    const run = atFirstCheckpoint();
    run.cancel(LATER);

    expect(() =>
      run.continueFromCheckpoint({ kind: 'phase', position: 1 }, undefined, LATER),
    ).toThrow(RunNotAtCheckpointError);
    expect(run.lifecycle.state).toBe('cancelled');
    expect(run.phasePending).toBe(false);
  });

  it('is refused for a Run that waits for an Answer', () => {
    const run = running(start());
    askQuestion(run);

    expect(() =>
      run.continueFromCheckpoint({ kind: 'phase', position: 1 }, undefined, LATER),
    ).toThrow(RunNotAtCheckpointError);
    expect(() => run.stopAtCheckpoint(LATER)).toThrow(RunNotAtCheckpointError);
  });

  it('is refused when it names another Checkpoint than the one the Run waits at', () => {
    const run = atFirstCheckpoint();

    expect(() => run.assertAtCheckpoint('build')).toThrow(RunNotAtCheckpointError);
    expect(() => run.assertAtCheckpoint('look')).not.toThrow();
    expect(() => run.assertAtCheckpoint(undefined)).not.toThrow();
  });

  it('waits again at the next Checkpoint when two come in a row, with a fresh waiting time', () => {
    const run = atSecondPhaseCheckpoint();
    expect(run.waiting).toMatchObject({ checkpoint: { id: 'first-look' } });

    run.continueFromCheckpoint({ kind: 'checkpoint', item: 4 }, undefined, LATER);

    expect(run.lifecycle.state).toBe('waiting_for_operator');
    expect(run.waiting).toMatchObject({ checkpoint: { id: 'second-look' } });
    expect(run.progress.waitingSince).toEqual(LATER);
    expect(run.phasePending).toBe(false);
    expect(run.currentPhase).toBe(1);
  });

  it('hands the comment of an earlier Checkpoint on to the Phase after the next one', () => {
    const run = atSecondPhaseCheckpoint();
    run.continueFromCheckpoint({ kind: 'checkpoint', item: 4 }, 'first note', LATER);

    run.continueFromCheckpoint({ kind: 'phase', position: 2 }, 'second note', LATER);

    expect(run.phases[2]!.checkpointComment).toBe('first note\n\nsecond note');
    expect(run.phases[1]!.checkpointComment).toBeNull();
  });
});

describe('the Workflow ending at a Checkpoint', () => {
  function atLastCheckpoint(): Run {
    const run = atSecondPhaseCheckpoint();
    run.continueFromCheckpoint({ kind: 'checkpoint', item: 4 }, undefined, LATER);
    run.continueFromCheckpoint({ kind: 'phase', position: 2 }, undefined, LATER);
    running(run, LATER);
    finishStep(run, 3, { kind: 'checkpoint', item: 6 });
    return run;
  }

  it('delivers what exists when the operator continues past the last Checkpoint', () => {
    const run = atLastCheckpoint();

    run.continueFromCheckpoint({ kind: 'end' }, 'Ship it.', LATER);

    expect(run.lifecycle.state).toBe('queued');
    expect(run.workflowEnded).toBe(true);
    expect(run.phasePending).toBe(true);
    expect(run.currentPhase).toBe(2);
    expect(run.phases[2]!.checkpointComment).toBeNull();
    expect(HandOutRule.for(WORKER).takes(run.handOutView())).toBe(true);
    expect(HandOutRule.for(OTHER_WORKER).takes(run.handOutView())).toBe(false);
    expect(run.handOut()).toEqual({ kind: 'deliver', runBranch: 'studio/run' });
  });

  it('delivers what exists when the operator stops', () => {
    const run = atFirstCheckpoint();

    run.stopAtCheckpoint(LATER);

    expect(run.lifecycle.state).toBe('queued');
    expect(run.workflowEnded).toBe(true);
    expect(run.currentPhase).toBe(0);
    expect(run.waiting).toBeNull();
    expect(run.handOut()).toEqual({ kind: 'deliver', runBranch: 'studio/run' });
    expect(run.pendingChanges().fields).toMatchObject({
      state: 'queued',
      checkpointItem: null,
      workflowEnded: true,
      phasePending: true,
    });
  });

  it('succeeds with the delivery the worker reports for the claim, and its Phase is done', () => {
    const run = atFirstCheckpoint();
    run.stopAtCheckpoint(LATER);
    run.claimBy(WORKER, LATER);

    run.reportState(
      WORKER,
      { state: 'succeeded', failure: null, delivery: { outcome: 'none' } },
      LATER,
    );

    expect(run.lifecycle.state).toBe('succeeded');
    expect(run.delivery.state).toBe('none');
    expect(run.phasePending).toBe(false);
    expect(run.phases.map((phase) => phase.state)).toEqual(['done', 'pending', 'pending']);
  });

  it('fails the delivery like any delivery that fails, so it can be retried', () => {
    const run = atFirstCheckpoint();
    run.stopAtCheckpoint(LATER);
    run.claimBy(WORKER, LATER);

    run.reportState(
      WORKER,
      { state: 'failed', failure: { code: 'delivery_failed', detail: 'no push' } },
      LATER,
    );

    expect(run.lifecycle.state).toBe('failed');
    expect(run.lifecycle.canRetryDelivery).toBe(true);
    expect(run.phasePending).toBe(false);
  });

  it('is refused the second time', () => {
    const run = atFirstCheckpoint();
    run.stopAtCheckpoint(LATER);

    expect(() => run.stopAtCheckpoint(LATER)).toThrow(RunNotAtCheckpointError);
    expect(() => run.continueFromCheckpoint({ kind: 'end' }, undefined, LATER)).toThrow(
      RunNotAtCheckpointError,
    );
  });

  it('is cancelled like any Run held for its delivery claim', () => {
    const run = atFirstCheckpoint();
    run.stopAtCheckpoint(LATER);

    run.cancel(LATER);

    expect(run.lifecycle.state).toBe('cancelled');
    expect(run.phasePending).toBe(false);
  });
});

describe('the Phase of a delivery that fails and is retried', () => {
  it('is failed with the failed delivery and done once the retry succeeds', () => {
    const run = running(start());
    finishStep(run, 1, { kind: 'end' });
    run.reportState(
      WORKER,
      { state: 'failed', failure: { code: 'delivery_failed', detail: 'no push' } },
      LATER,
    );
    expect(run.phases[0]!.state).toBe('failed');

    run.requestDeliveryRetry();
    run.claimBy(WORKER, LATER);
    run.reportState(
      WORKER,
      { state: 'succeeded', failure: null, delivery: { outcome: 'none' } },
      LATER,
    );

    expect(run.lifecycle.state).toBe('succeeded');
    expect(run.phases[0]!.state).toBe('done');
  });
});

describe('a Run waiting at a Checkpoint for too long', () => {
  it('is cancelled by Studio like a Run waiting for an Answer', () => {
    const run = atFirstCheckpoint();

    const cancelled = run.cancelAfterWaiting(
      { by: 'system', reason: 'Waited too long.' } as never,
      LATER,
    );

    expect(cancelled).toBe(true);
    expect(run.lifecycle.state).toBe('cancelled');
    expect(run.waiting).toBeNull();
    expect(run.pendingChanges().fields.checkpointItem).toBeNull();
  });
});
