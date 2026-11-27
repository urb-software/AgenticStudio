import { describe, expect, it } from 'vitest';
import { Task } from '../../value-objects/task.js';
import { Run } from '../run.js';
import { phaseAgent, WORKFLOW_COMMIT } from './workflow-run-fixtures.js';

const AT = new Date('2026-11-15T12:00:00.000Z');
const WORKER = '7d1f3a5c-9e2b-4c6d-8a0e-1b3d5f7a9c2e';
const WORKING_COPY = { runBranch: 'studio/run', commits: [], hasUncommittedChanges: true };

/** Work, then review, then more work: the review is the second Phase. */
function reviewRun(): Run {
  const builder = phaseAgent('builder');
  return Run.start({
    id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
    projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
    provider: builder.provider,
    agent: builder,
    workflow: {
      record: {
        name: 'build-and-review',
        commit: WORKFLOW_COMMIT,
        items: [
          { id: 'build', kind: 'work', agent: 'builder' },
          { id: 'check', kind: 'review', agent: 'reviewer' },
        ],
      },
      phaseAgents: [builder, phaseAgent('reviewer', 'claude_code')],
    },
    task: Task.of('Add a health check'),
    startCommit: 'a'.repeat(40),
    remoteUrl: 'https://git.example.test/a.git',
    integrationBranch: 'dev',
    limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 },
    now: AT,
  });
}

function claim(run: Run): void {
  run.claimBy(WORKER, AT);
  run.reportState(WORKER, { state: 'running', failure: null }, AT);
}

/** The Run with its work Phase done and its review Phase running. */
function inReview(): Run {
  const run = reviewRun();
  claim(run);
  run.reportStep(
    WORKER,
    { kind: 'start', index: 1, result: { outcome: 'done', summary: 'Built.' } },
    WORKING_COPY,
    [],
    AT,
    { kind: 'phase', position: 1 },
  );
  claim(run);
  return run;
}

const review = (
  run: Run,
  record: { verdict?: 'approved' | 'changes_requested'; findings?: { text: string }[] },
  next?: Parameters<Run['reportStep']>[5],
) =>
  run.reportStep(
    WORKER,
    {
      kind: 'start',
      index: 2,
      result: { outcome: 'done', summary: 'Reviewed.', ...record },
      ...record,
    },
    WORKING_COPY,
    [],
    AT,
    next,
  );

describe('a Run with a review Phase', () => {
  it('records the Phase as a review, and the work Phase as work', () => {
    expect(reviewRun().phases.map((phase) => [phase.itemId, phase.kind])).toEqual([
      ['build', 'work'],
      ['check', 'review'],
    ]);
  });

  it('stores the Verdict and the findings with the Phase, and the Run has not failed the review', () => {
    const run = inReview();
    const findings = [{ text: 'Looks fine.' }];

    review(run, { verdict: 'approved', findings }, { kind: 'end' });

    const phase = run.phases[1]!;
    expect([phase.verdict, phase.findings, phase.summary]).toEqual([
      'approved',
      findings,
      'Reviewed.',
    ]);
    expect(run.reviewNotPassed).toBe(false);
    expect(run.pendingChanges().fields.phaseUpdates?.[1]).toMatchObject({
      verdict: 'approved',
      findings,
    });
  });

  it('marks the Run "review not passed" for changes requested, and the Run still goes on to deliver', () => {
    const run = inReview();

    review(run, { verdict: 'changes_requested', findings: [{ text: 'Wrong.' }] }, { kind: 'end' });

    expect(run.reviewNotPassed).toBe(true);
    expect(run.lifecycle.state).toBe('running');
    run.reportState(
      WORKER,
      { state: 'succeeded', failure: null, delivery: { outcome: 'none' } },
      AT,
    );
    expect(run.lifecycle.state).toBe('succeeded');
    expect(run.reviewNotPassed).toBe(true);
    expect(run.phases.map((phase) => phase.state)).toEqual(['done', 'done']);
  });

  it('fails the Run, storing nothing, when a review Phase is done without a Verdict', () => {
    const run = inReview();

    const outcome = review(run, {});

    expect(outcome).toEqual({ status: 'verdict_missing' });
    expect(run.lifecycle.state).toBe('failed');
    expect(run.lifecycle.failure).toMatchObject({
      code: 'agent_failed',
      detail: 'The review Phase ended without a valid Verdict.',
    });
    expect(run.pendingChanges().steps?.map((step) => step.index)).toEqual([1]);
    expect(run.phases[1]!.state).toBe('failed');
  });

  it('lets a review Phase ask a question without a Verdict', () => {
    const run = inReview();

    const outcome = run.reportStep(
      WORKER,
      {
        kind: 'start',
        index: 2,
        result: { outcome: 'needs_input', summary: 'Stuck.' },
        question: { text: 'Which?' },
        sessionRef: 's-2',
      },
      WORKING_COPY,
      [],
      AT,
    );

    expect(outcome).toEqual({ status: 'stored', index: 2 });
    expect(run.lifecycle.state).toBe('running');
  });

  it('has no Verdict, and no "review not passed", before the review is done', () => {
    const run = inReview();

    expect(run.phases.map((phase) => phase.verdict)).toEqual([null, null]);
    expect(run.reviewNotPassed).toBe(false);
  });
});
