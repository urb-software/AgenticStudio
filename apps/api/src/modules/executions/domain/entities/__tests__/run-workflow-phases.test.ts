import { describe, expect, it } from 'vitest';
import { defaultAgentOf } from '../../repositories/__tests__/in-memory-run-repository.js';
import { HandOutRule } from '../../value-objects/hand-out-rule.js';
import { Task } from '../../value-objects/task.js';
import { Run } from '../run.js';
import { workflowRun } from './workflow-run-fixtures.js';

const AT = new Date('2026-11-15T12:00:00.000Z');
const WORKER = '7d1f3a5c-9e2b-4c6d-8a0e-1b3d5f7a9c2e';
const OTHER_WORKER = '5b9d3f1a-2c4e-4a6b-8d0f-7e9a1c3b5d2f';

const WORKING_COPY = { runBranch: 'studio/run', commits: [], hasUncommittedChanges: true };

function running(run: Run): Run {
  run.claimBy(WORKER, AT);
  run.reportState(WORKER, { state: 'running', failure: null }, AT);
  return run;
}

function finishStep(
  run: Run,
  index: number,
  next: Parameters<Run['reportStep']>[5],
  summary = 'did it',
) {
  return run.reportStep(
    WORKER,
    {
      kind: 'start',
      index,
      result: { outcome: 'done', summary },
      sessionRef: `session-${index}`,
    },
    WORKING_COPY,
    [],
    AT,
    next,
  );
}

function reclaim(run: Run): void {
  run.claimBy(WORKER, AT);
  run.reportState(WORKER, { state: 'running', failure: null }, AT);
}

describe('a Run started with a Workflow', () => {
  it('records its Workflow and one pending Phase per work item, the first being current', () => {
    const run = workflowRun();

    expect(run.workflow?.name).toBe('build-and-polish');
    expect(run.currentPhase).toBe(0);
    expect(run.agent.name).toBe('builder');
    expect(run.phases.map((phase) => [phase.itemId, phase.agent.name, phase.state])).toEqual([
      ['build', 'builder', 'pending'],
      ['polish', 'polisher', 'pending'],
      ['finish', 'finisher', 'pending'],
    ]);
  });

  it('refuses a Workflow with a review Phase', () => {
    const builder = { ...defaultAgentOf('codex'), name: 'builder' };
    expect(() =>
      Run.start({
        id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
        projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
        provider: builder.provider,
        agent: builder,
        workflow: {
          record: {
            name: 'w',
            commit: 'c'.repeat(40),
            items: [
              { id: 'build', kind: 'work', agent: 'builder' },
              { id: 'check', kind: 'review', agent: 'builder' },
            ],
          },
          phaseAgents: [builder, builder],
        },
        task: Task.of('x'),
        startCommit: 'a',
        remoteUrl: 'https://git.example.test/a.git',
        integrationBranch: 'dev',
        limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 },
        now: AT,
      }),
    ).toThrow(TypeError);
  });

  it('marks the first Phase running when the worker reports it', () => {
    const run = running(workflowRun());

    expect(run.phases.map((phase) => phase.state)).toEqual(['running', 'pending', 'pending']);
  });

  it('queues the next Phase when a Phase ends with done, in its own session and Provider', () => {
    const run = running(workflowRun());

    finishStep(run, 1, { kind: 'phase', position: 1 }, 'built it');

    expect(run.lifecycle.state).toBe('queued');
    expect(run.claim.claimedBy).toBeNull();
    expect(run.phasePending).toBe(true);
    expect(run.currentPhase).toBe(1);
    expect(run.agent.name).toBe('polisher');
    expect(run.provider).toBe('claude_code');
    expect(run.claim.sessionRef).toBeNull();
    expect(run.progress.stepsBeforePart).toBe(1);
    const [first, second] = run.phases;
    expect(first).toMatchObject({ state: 'done', sessionRef: 'session-1', summary: 'built it' });
    expect(first!.stepsUsed).toBe(1);
    expect(second).toMatchObject({ state: 'pending', sessionRef: null, stepsUsed: 0 });
  });

  it('records the Phase the Run moved to, keeping the session of the one it left', () => {
    const run = running(workflowRun());

    finishStep(run, 1, { kind: 'phase', position: 1 });

    const { fields } = run.pendingChanges();
    expect(fields.currentPhase).toBe(1);
    expect(fields.provider).toBe('claude_code');
    expect(fields.phasePending).toBe(true);
    expect(fields.phaseUpdates?.[0]).toMatchObject({ state: 'done', sessionRef: 'session-1' });
  });

  it('hands the next Phase out as a claim of its own, only to the worker that has the Working copy', () => {
    const run = running(workflowRun());
    finishStep(run, 1, { kind: 'phase', position: 1 });

    const view = run.handOutView();
    expect(HandOutRule.for(WORKER).takes(view)).toBe(true);
    expect(HandOutRule.for(OTHER_WORKER).takes(view)).toBe(false);
    expect(HandOutRule.countingPlaces().holdsPlace(view)).toBe(true);
    expect(run.handOut()).toEqual({ kind: 'next_phase', runBranch: 'studio/run' });
  });

  it('takes the claim for the next Phase like any other, and is no longer pending once it runs', () => {
    const run = running(workflowRun());
    finishStep(run, 1, { kind: 'phase', position: 1 });

    run.claimBy(WORKER, AT);

    expect(run.lifecycle.state).toBe('preparing');
    expect(run.handOut()).toEqual({ kind: 'next_phase', runBranch: 'studio/run' });
    run.reportState(WORKER, { state: 'running', failure: null }, AT);
    expect(run.phasePending).toBe(false);
    expect(run.phases.map((phase) => phase.state)).toEqual(['done', 'running', 'pending']);
  });

  it('gives each Phase its own Run step allowance', () => {
    const run = running(workflowRun(1));
    finishStep(run, 1, { kind: 'phase', position: 1 });
    reclaim(run);

    const second = run.reportStep(
      WORKER,
      { kind: 'start', index: 2, result: { outcome: 'done', summary: 's' } },
      WORKING_COPY,
      [],
      AT,
      { kind: 'phase', position: 2 },
    );

    expect(second).toEqual({ status: 'stored', index: 2 });
    expect(run.currentPhase).toBe(2);
  });

  it('fails the Run when a Phase takes more Run steps than its allowance', () => {
    const run = running(workflowRun(1));
    finishStep(run, 1, { kind: 'phase', position: 1 });
    reclaim(run);
    run.reportStep(
      WORKER,
      { kind: 'start', index: 2, result: { outcome: 'needs_input', summary: 's' } },
      WORKING_COPY,
      [],
      AT,
    );

    const third = run.reportStep(
      WORKER,
      { kind: 'resume', index: 3, result: { outcome: 'done', summary: 's' } },
      WORKING_COPY,
      [],
      AT,
    );

    expect(third).toEqual({ status: 'step_limit' });
    expect(run.lifecycle.state).toBe('failed');
    expect(run.phases.map((phase) => phase.state)).toEqual(['done', 'failed', 'pending']);
  });

  it('ends the Run when the total of Run steps is reached, whatever the allowance of the Phase', () => {
    const run = workflowRun(5, 2);
    running(run);
    finishStep(run, 1, { kind: 'phase', position: 1 });
    reclaim(run);
    finishStep(run, 2, { kind: 'phase', position: 2 });
    reclaim(run);

    const third = run.reportStep(
      WORKER,
      { kind: 'start', index: 3, result: { outcome: 'done', summary: 's' } },
      WORKING_COPY,
      [],
      AT,
      { kind: 'end' },
    );

    expect(third).toEqual({ status: 'step_limit' });
    expect(run.lifecycle.failure?.code).toBe('step_limit');
    expect(run.lifecycle.failure?.detail).toContain('total limit of 2 run steps');
  });

  it('does not move on twice for a step report that is sent again', () => {
    const run = running(workflowRun());
    finishStep(run, 1, { kind: 'phase', position: 1 });

    const again = finishStep(run, 1, { kind: 'phase', position: 2 });

    expect(again).toEqual({ status: 'stored', index: 1, duplicate: true });
    expect(run.currentPhase).toBe(1);
  });

  it('stays on its last Phase when the Workflow ends, and the Phase is done when the Run succeeds', () => {
    const run = running(workflowRun());
    finishStep(run, 1, { kind: 'phase', position: 1 });
    reclaim(run);
    finishStep(run, 2, { kind: 'phase', position: 2 });
    reclaim(run);

    finishStep(run, 3, { kind: 'end' });

    expect(run.lifecycle.state).toBe('running');
    expect(run.currentPhase).toBe(2);
    run.reportState(
      WORKER,
      { state: 'succeeded', failure: null, delivery: { outcome: 'none' } },
      AT,
    );
    expect(run.phases.map((phase) => phase.state)).toEqual(['done', 'done', 'done']);
  });

  it('ends cancelled, not queued, when the operator asked to cancel while a Phase ended', () => {
    const run = running(workflowRun());
    run.cancel(AT);

    finishStep(run, 1, { kind: 'phase', position: 1 });

    expect(run.lifecycle.state).toBe('cancelled');
    expect(run.currentPhase).toBe(0);
    expect(run.phasePending).toBe(false);
  });

  it.each([
    ['is cancelled while it waits', (run: Run) => run.cancel(AT)],
    [
      'is abandoned because its worker is gone',
      (run: Run) => run.abandonResume({ code: 'worker_lost', detail: 'gone' } as never, AT),
    ],
    [
      'fails at its claim',
      (run: Run) => {
        run.claimBy(WORKER, AT);
        run.failPreparation(WORKER, { code: 'preparation_failed', detail: 'x' } as never, AT);
      },
    ],
  ])('holds no pending Phase once the Run %s', (_case, end) => {
    const run = running(workflowRun());
    finishStep(run, 1, { kind: 'phase', position: 1 });
    expect(run.phasePending).toBe(true);

    end(run);

    expect(run.lifecycle.isFinal).toBe(true);
    expect(run.phasePending).toBe(false);
    expect(run.pendingChanges().fields.phasePending).toBe(false);
  });

  it('ends its Phase as failed with the Run', () => {
    const run = running(workflowRun());

    run.reportState(
      WORKER,
      { state: 'failed', failure: { code: 'agent_failed', detail: 'no' } },
      AT,
    );

    expect(run.phases.map((phase) => phase.state)).toEqual(['failed', 'pending', 'pending']);
  });

  it('shows a Phase of a Run that the database swept as failed, not running', () => {
    const run = running(workflowRun());

    const swept = Run.restore({
      ...workflowRunData(run),
      state: 'timed_out',
      claimedBy: null,
      heartbeatAt: null,
      finishedAt: AT,
    });

    expect(swept.phases.map((phase) => phase.state)).toEqual(['failed', 'pending', 'pending']);
  });
});

function workflowRunData(run: Run): Parameters<typeof Run.restore>[0] {
  return {
    id: run.id,
    projectId: run.projectId,
    provider: run.provider,
    agent: run.agent.toData(),
    workflow: run.workflow!.toData(),
    phases: run.phases,
    currentPhase: run.currentPhase,
    task: run.task,
    startCommit: run.startCommit,
    remoteUrl: run.remoteUrl,
    createdAt: run.createdAt,
    workingCopy: run.workingCopy,
    failingChecks: [],
    pullRequestStatus: run.pullRequestStatus.toData(),
    ...run.lifecycle.toData(),
    ...run.delivery.toData(),
    ...run.claim.toData(),
    ...run.progress.toData(),
    messages: [...run.conversation.messages],
  };
}
