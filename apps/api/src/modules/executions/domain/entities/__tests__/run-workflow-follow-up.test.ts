import { describe, expect, it } from 'vitest';
import { FollowUpNotAllowedError } from '../../errors/run-errors.js';
import type { Run } from '../run.js';
import { workflowRun } from './workflow-run-fixtures.js';

const AT = new Date('2026-11-15T12:00:00.000Z');
const WORKER = '7d1f3a5c-9e2b-4c6d-8a0e-1b3d5f7a9c2e';
const AVAILABLE = { workerAvailable: true, providerAvailable: true };
const WORKING_COPY = { runBranch: 'studio/run', commits: [], hasUncommittedChanges: true };

function runPhase(run: Run, index: number, next: Parameters<Run['reportStep']>[5]): void {
  run.claimBy(WORKER, AT);
  run.reportState(WORKER, { state: 'running', failure: null }, AT);
  run.reportStep(
    WORKER,
    {
      kind: 'start',
      index,
      result: { outcome: 'done', summary: `Phase ${index} done.` },
      sessionRef: `session-${index}`,
    },
    WORKING_COPY,
    [],
    AT,
    next,
  );
}

/** A Workflow Run of three Phases that ran to the end and delivered. */
function finished(): Run {
  const run = workflowRun(5);
  runPhase(run, 1, { kind: 'phase', position: 1 });
  runPhase(run, 2, { kind: 'phase', position: 2 });
  runPhase(run, 3, { kind: 'end' });
  run.reportState(WORKER, { state: 'succeeded', failure: null, delivery: { outcome: 'none' } }, AT);
  return run;
}

describe('a Follow-up to a finished Workflow Run', () => {
  it('starts again at the first Phase, resuming its session', () => {
    const run = finished();

    run.followUp('Add a test too.', AT, AVAILABLE);

    expect(run.currentPhase).toBe(0);
    expect(run.agent.name).toBe('builder');
    expect(run.provider).toBe('codex');
    expect(run.claim.sessionRef).toBe('session-1');
    expect(run.phasePending).toBe(false);
    expect(run.phases.map((phase) => phase.state)).toEqual(['pending', 'pending', 'pending']);
    expect(run.handOut()).toMatchObject({
      kind: 'resume',
      sessionRef: 'session-1',
      answer: 'Add a test too.',
      reason: 'follow_up',
      followUpNumber: 1,
    });
  });

  it('gives each Phase a fresh allowance, counted from the Run steps taken so far', () => {
    const run = finished();

    run.followUp('Again.', AT, AVAILABLE);

    expect(run.progress.stepsBeforePart).toBe(3);
  });

  it('works through the later Phases in the sessions they had, one claim each', () => {
    const run = finished();
    run.followUp('Again.', AT, AVAILABLE);
    run.claimBy(WORKER, AT);
    run.reportState(WORKER, { state: 'running', failure: null }, AT);

    run.reportStep(
      WORKER,
      { kind: 'resume', index: 4, result: { outcome: 'done', summary: 'Again, first.' } },
      WORKING_COPY,
      [],
      AT,
      { kind: 'phase', position: 1 },
    );

    expect(run.currentPhase).toBe(1);
    expect(run.provider).toBe('claude_code');
    expect(run.handOut()).toMatchObject({
      kind: 'next_phase',
      session: { sessionRef: 'session-2', answer: 'Again.', reason: 'follow_up' },
      followUpNumber: 1,
    });
  });

  it('brings the branch up to date in the last Phase, in its session', () => {
    const run = finished();

    run.followUp('', AT, AVAILABLE, 'bring_up_to_date');

    expect(run.currentPhase).toBe(2);
    expect(run.claim.sessionRef).toBe('session-3');
    expect(run.handOut()).toMatchObject({
      kind: 'resume',
      sessionRef: 'session-3',
      reason: 'bring_up_to_date',
    });
  });

  /** A Follow-up round whose first Phase has run to a Question, answered, and is now done. */
  function secondRoundAfterQuestion(): Run {
    const run = finished();
    run.followUp('Again.', AT, AVAILABLE);
    run.claimBy(WORKER, AT);
    run.reportState(WORKER, { state: 'running', failure: null }, AT);
    run.reportStep(
      WORKER,
      {
        kind: 'resume',
        index: 4,
        result: { outcome: 'needs_input', summary: 'q' },
        question: { text: 'Which one?' },
        sessionRef: 'session-1',
      },
      WORKING_COPY,
      [],
      AT,
    );
    run.reportState(WORKER, { state: 'waiting_for_operator', failure: null }, AT);
    run.answer('Take B.', AT);
    run.claimBy(WORKER, AT);
    run.reportState(WORKER, { state: 'running', failure: null }, AT);
    run.reportStep(
      WORKER,
      { kind: 'resume', index: 5, result: { outcome: 'done', summary: 'done' } },
      WORKING_COPY,
      [],
      AT,
      { kind: 'phase', position: 1 },
    );
    return run;
  }

  it('gives a later Phase the Follow-up text, though a Question was answered in an earlier Phase', () => {
    const run = secondRoundAfterQuestion();

    expect(run.handOut()).toMatchObject({
      kind: 'next_phase',
      session: { sessionRef: 'session-2', answer: 'Again.', reason: 'follow_up' },
      followUpNumber: 1,
    });
  });

  it('gives a later Phase the Follow-up text after a usage-limit resume of an earlier Phase', () => {
    const run = finished();
    run.followUp('Again.', AT, AVAILABLE);
    run.claimBy(WORKER, AT);
    run.reportState(WORKER, { state: 'running', failure: null }, AT);
    run.reportState(
      WORKER,
      {
        state: 'failed',
        failure: { code: 'usage_limit', detail: 'limit' },
        sessionRef: 'session-1',
      },
      AT,
    );
    run.resumeAfterUsageLimit(AT, {
      projectPlaceTaken: false,
      serverPlacesTaken: 0,
      environmentFileSnapshotKept: true,
    });
    run.claimBy(WORKER, AT);
    run.reportState(WORKER, { state: 'running', failure: null }, AT);
    run.reportStep(
      WORKER,
      { kind: 'resume', index: 4, result: { outcome: 'done', summary: 'done' } },
      WORKING_COPY,
      [],
      AT,
      { kind: 'phase', position: 1 },
    );

    expect(run.handOut()).toMatchObject({
      kind: 'next_phase',
      session: { sessionRef: 'session-2', answer: 'Again.', reason: 'follow_up' },
    });
  });

  it('is refused while a Provider of any Phase is not available', () => {
    const run = finished();

    expect(() => run.followUp('x', AT, { ...AVAILABLE, providerAvailable: false })).toThrow(
      FollowUpNotAllowedError,
    );
  });

  it('is refused for a Run whose first Phase has no session to resume', () => {
    const run = workflowRun(5);
    run.claimBy(WORKER, AT);
    run.reportState(WORKER, { state: 'running', failure: null }, AT);
    run.reportStep(
      WORKER,
      { kind: 'start', index: 1, result: { outcome: 'done', summary: 's' } },
      WORKING_COPY,
      [],
      AT,
      { kind: 'phase', position: 1 },
    );
    run.claimBy(WORKER, AT);
    run.reportState(
      WORKER,
      { state: 'failed', failure: { code: 'agent_failed', detail: 'x' } },
      AT,
    );

    expect(() => run.followUp('x', AT, AVAILABLE)).toThrow(FollowUpNotAllowedError);
  });

  it('asks every Provider the Phases use of the agent workers', () => {
    const run = finished();
    const claude = { latest: undefined, holderLastSeen: undefined };

    expect(run.followUpFacts(claude, AT, 60)).toEqual({
      workerAvailable: false,
      providerAvailable: false,
    });
  });
});
