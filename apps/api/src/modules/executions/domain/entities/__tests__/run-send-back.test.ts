import { describe, expect, it } from 'vitest';
import type { RunWorkflowItem } from '../../value-objects/run-workflow.js';
import { Task } from '../../value-objects/task.js';
import { Run } from '../run.js';
import { phaseAgent, WORKFLOW_COMMIT } from './workflow-run-fixtures.js';

const AT = new Date('2026-11-15T12:00:00.000Z');
const WORKER = '7d1f3a5c-9e2b-4c6d-8a0e-1b3d5f7a9c2e';
const WORKING_COPY = { runBranch: 'studio/run', commits: [], hasUncommittedChanges: true };
const AVAILABLE = { workerAvailable: true, providerAvailable: true };

const ITEMS: RunWorkflowItem[] = [
  { id: 'build', kind: 'work', agent: 'builder' },
  { id: 'check', kind: 'review', agent: 'reviewer' },
];

function workflow(items = ITEMS, sendBacks?: number, maxTotalSteps = 20): Run {
  const phases = items.filter((item) => item.kind !== 'checkpoint');
  const agents = phases.map((item) =>
    phaseAgent((item as { agent: string }).agent, item.kind === 'review' ? 'claude_code' : 'codex'),
  );
  return Run.start({
    id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
    projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
    provider: agents[0]!.provider,
    agent: agents[0]!,
    workflow: {
      record: {
        name: 'build-and-review',
        commit: WORKFLOW_COMMIT,
        items,
        ...(sendBacks === undefined ? {} : { sendBacks }),
      },
      phaseAgents: agents,
    },
    task: Task.of('Add a health check'),
    startCommit: 'a'.repeat(40),
    remoteUrl: 'https://git.example.test/a.git',
    integrationBranch: 'dev',
    limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps },
    now: AT,
  });
}

type Next = Parameters<Run['reportStep']>[5];

let index = 0;

/** Claims the Run and reports one done step of the current Phase. */
function step(run: Run, next: Next, record: object = {}, summary = 'Done.'): void {
  index = run.progress.stepCount + 1;
  run.claimBy(WORKER, AT);
  run.reportState(WORKER, { state: 'running', failure: null }, AT);
  run.reportStep(
    WORKER,
    {
      kind: 'start',
      index,
      result: { outcome: 'done', summary, ...record },
      sessionRef: `session-${run.currentPhase}`,
      ...record,
    },
    WORKING_COPY,
    [],
    AT,
    next,
  );
}

const changes = (findings = [{ text: 'Wrong.' }]) => ({
  verdict: 'changes_requested' as const,
  findings,
});

/** Built, then a review that asked for changes and sent the work back. */
function sentBack(sendBacks?: number): Run {
  const run = workflow(ITEMS, sendBacks);
  step(run, { kind: 'phase', position: 1 }, {}, 'Built.');
  step(run, { kind: 'send_back', position: 0 }, changes(), 'Reviewed.');
  return run;
}

describe('a Run that sends work back', () => {
  it('counts a send-back with the Run, and queues the work Phase for its own worker', () => {
    const run = sentBack();

    expect(run.lifecycle.state).toBe('queued');
    expect(run.currentPhase).toBe(0);
    expect(run.phasePending).toBe(true);
    expect(run.sendBacksUsed).toBe(1);
    expect(run.sendBackReview).toBe(1);
    expect(run.sendBack).toEqual({ used: 1, limit: 2 });
    expect(run.claim.releasedBy).toBe(WORKER);
    expect(run.pendingChanges().fields).toMatchObject({
      sendBacksUsed: 1,
      sendBackReview: 1,
      currentPhase: 0,
    });
  });

  it('hands the work Phase its own session back, in a claim Studio words itself', () => {
    const run = sentBack();

    const handOut = run.handOut();

    expect(handOut).toMatchObject({
      kind: 'next_phase',
      runBranch: 'studio/run',
      session: { sessionRef: 'session-0', reason: 'send_back' },
    });
    const { answer } = (handOut as { session: { answer: string } }).session;
    expect(answer).toContain('review');
    expect(answer).not.toContain('Wrong.');
  });

  it('keeps the findings out of the answer, for the claim to carry as untrusted text', () => {
    const run = sentBack();

    expect(run.sendBackClaim).toEqual({
      round: 1,
      limit: 2,
      returning: false,
      findings: [{ text: 'Wrong.' }],
    });
  });

  it('keeps each round of a Phase: the earlier results are archived, the current one is empty', () => {
    const run = sentBack();

    const [work, review] = run.phases;
    expect(work!.rounds).toEqual([{ round: 1, summary: 'Built.', verdict: null, findings: [] }]);
    expect(review!.rounds).toEqual([
      {
        round: 1,
        summary: 'Reviewed.',
        verdict: 'changes_requested',
        findings: [{ text: 'Wrong.' }],
      },
    ]);
    expect([work!.summary, review!.verdict, review!.findings]).toEqual([null, null, []]);
    expect(run.pendingChanges().fields.phaseUpdates).toMatchObject({
      0: { summary: null, rounds: [{ round: 1 }] },
      1: { verdict: null, rounds: [{ round: 1 }] },
    });
  });

  it('gives the round its own allowance of Run steps, counted from the steps taken so far', () => {
    const run = sentBack();

    expect(run.progress.stepsBeforePart).toBe(2);
  });

  it('sends the work Phase straight back to the review that asked, then the review resumes its session', () => {
    const run = sentBack();
    step(run, { kind: 'phase', position: 1 }, {}, 'Fixed.');

    expect(run.currentPhase).toBe(1);
    expect(run.sendBackReview).toBe(1);
    expect(run.sendBackClaim).toMatchObject({ round: 1, returning: true });
    expect(run.sendBackClaim?.findings).toEqual([]);
    expect(run.handOut()).toMatchObject({
      kind: 'next_phase',
      session: { sessionRef: 'session-1', reason: 'send_back' },
    });
    expect(run.phases[0]!.rounds).toHaveLength(1);
    expect(run.phases[0]!.summary).toBe('Fixed.');
  });

  it('ends the round when the review gives its Verdict again: approved goes on', () => {
    const run = sentBack();
    step(run, { kind: 'phase', position: 1 }, {}, 'Fixed.');

    step(run, { kind: 'end' }, { verdict: 'approved', findings: [] }, 'Fine now.');

    expect(run.sendBackReview).toBeNull();
    expect(run.sendBacksUsed).toBe(1);
    expect(run.reviewNotPassed).toBe(false);
    expect(run.phases[1]!.verdict).toBe('approved');
    expect(run.phases[1]!.rounds.map((round) => round.round)).toEqual([1]);
  });

  it('sends back a second time while the count is below the limit, and counts both', () => {
    const run = sentBack();
    step(run, { kind: 'phase', position: 1 }, {}, 'Fixed.');

    step(run, { kind: 'send_back', position: 0 }, changes([{ text: 'Still wrong.' }]));

    expect(run.sendBacksUsed).toBe(2);
    expect(run.sendBack).toEqual({ used: 2, limit: 2 });
    expect(run.sendBackClaim).toMatchObject({
      round: 2,
      findings: [{ text: 'Still wrong.' }],
      returning: false,
    });
    expect(run.phases[1]!.rounds.map((round) => round.round)).toEqual([1, 2]);
  });

  it('refuses to send back past the limit the Run recorded, whatever it is told', () => {
    const run = sentBack(1);
    step(run, { kind: 'phase', position: 1 }, {}, 'Fixed.');
    run.claimBy(WORKER, AT);
    run.reportState(WORKER, { state: 'running', failure: null }, AT);

    expect(() =>
      run.reportStep(
        WORKER,
        { kind: 'start', index: 4, result: { outcome: 'done', summary: 'No.' }, ...changes() },
        WORKING_COPY,
        [],
        AT,
        { kind: 'send_back', position: 0 },
      ),
    ).toThrow(TypeError);
    expect(run.sendBacksUsed).toBe(1);
  });

  it('never has a limit above two, nor one the record does not carry', () => {
    expect(sentBack(7).sendBack).toEqual({ used: 1, limit: 2 });
    expect(workflow().sendBack).toEqual({ used: 0, limit: 2 });
    expect(workflow(ITEMS, 0).sendBack).toEqual({ used: 0, limit: 0 });
  });

  it('ends at the limit as "review not passed" and goes on to deliver the open findings', () => {
    const run = sentBack(1);
    step(run, { kind: 'phase', position: 1 }, {}, 'Fixed.');

    step(run, { kind: 'end' }, changes([{ text: 'Open.' }]));

    expect(run.reviewNotPassed).toBe(true);
    expect(run.phases[1]!.findings).toEqual([{ text: 'Open.' }]);
    expect(run.sendBackReview).toBeNull();
    expect(run.sendBacksUsed).toBe(1);
    expect(run.lifecycle.state).toBe('running');
  });

  it('shows no send-back for a Run started with an agent', () => {
    expect(
      Run.start({
        id: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
        projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
        provider: 'codex',
        agent: phaseAgent('builder'),
        task: Task.of('x'),
        startCommit: 'a'.repeat(40),
        remoteUrl: 'https://git.example.test/a.git',
        integrationBranch: 'dev',
        limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 },
        now: AT,
      }).sendBack,
    ).toBeNull();
  });

  it('is cancelled by the operator in any round: nothing is queued, and nothing is counted', () => {
    const run = workflow();
    step(run, { kind: 'phase', position: 1 }, {}, 'Built.');
    run.claimBy(WORKER, AT);
    run.reportState(WORKER, { state: 'running', failure: null }, AT);
    run.cancel(AT);

    run.reportStep(
      WORKER,
      { kind: 'start', index: 2, result: { outcome: 'done', summary: 'x' }, ...changes() },
      WORKING_COPY,
      [],
      AT,
      { kind: 'send_back', position: 0 },
    );

    expect(run.lifecycle.state).toBe('cancelled');
    expect(run.phasePending).toBe(false);
    expect(run.sendBacksUsed).toBe(0);
  });

  it('cancels a Run that waits for the work Phase of a round, nothing more starts', () => {
    const run = sentBack();

    run.cancel(AT);

    expect(run.lifecycle.state).toBe('cancelled');
    expect(run.phasePending).toBe(false);
  });

  it('asks a Question in a round and goes on in the same Phase and round', () => {
    const run = sentBack();
    run.claimBy(WORKER, AT);
    run.reportState(WORKER, { state: 'running', failure: null }, AT);
    run.reportStep(
      WORKER,
      {
        kind: 'resume',
        index: 3,
        result: { outcome: 'needs_input', summary: 'Stuck.' },
        question: { text: 'Which one?' },
        sessionRef: 'session-0b',
      },
      WORKING_COPY,
      [],
      AT,
    );
    run.reportState(WORKER, { state: 'waiting_for_operator', failure: null }, AT);

    expect(run.currentPhase).toBe(0);
    expect(run.sendBackReview).toBe(1);
    expect(run.sendBackClaim).toMatchObject({ round: 1, returning: false });
    expect(run.sendBack).toEqual({ used: 1, limit: 2 });
  });

  it('keeps the round of the right Phase when the usage limit stops it', () => {
    const run = sentBack();
    run.claimBy(WORKER, AT);
    run.reportState(WORKER, { state: 'running', failure: null }, AT);
    run.reportState(
      WORKER,
      {
        state: 'failed',
        failure: { code: 'usage_limit', detail: 'Limit reached.' },
        workingCopy: WORKING_COPY,
        sessionRef: 'session-0b',
      },
      AT,
    );

    expect(run.currentPhase).toBe(0);
    expect(run.sendBackReview).toBe(1);
    expect(run.sendBackClaim).toMatchObject({ round: 1, returning: false });
    expect(run.sendBacksUsed).toBe(1);
  });

  it('starts a fresh session with the findings when the work Phase has none to resume', () => {
    const run = workflow();
    run.claimBy(WORKER, AT);
    run.reportState(WORKER, { state: 'running', failure: null }, AT);
    run.reportStep(
      WORKER,
      { kind: 'start', index: 1, result: { outcome: 'done', summary: 'Built.' } },
      WORKING_COPY,
      [],
      AT,
      { kind: 'phase', position: 1 },
    );
    step(run, { kind: 'send_back', position: 0 }, changes());

    const handOut = run.handOut();

    expect(handOut.kind).toBe('next_phase');
    expect('session' in handOut).toBe(false);
  });
});

describe('the send-back count of a Run with two review Phases', () => {
  const TWO: RunWorkflowItem[] = [
    { id: 'build', kind: 'work', agent: 'builder' },
    { id: 'check', kind: 'review', agent: 'reviewer' },
    { id: 'fix', kind: 'work', agent: 'fixer' },
    { id: 'final', kind: 'review', agent: 'judge' },
  ];

  it('is one count for the Run: both reviews draw from it', () => {
    const run = workflow(TWO);
    step(run, { kind: 'phase', position: 1 });
    step(run, { kind: 'send_back', position: 0 }, changes());
    expect(run.sendBacksUsed).toBe(1);
    step(run, { kind: 'phase', position: 1 });
    step(run, { kind: 'phase', position: 2 }, { verdict: 'approved', findings: [] });
    step(run, { kind: 'phase', position: 3 });

    step(run, { kind: 'send_back', position: 2 }, changes([{ text: 'Late.' }]));

    expect(run.sendBacksUsed).toBe(2);
    expect(run.currentPhase).toBe(2);
    expect(run.sendBackReview).toBe(3);
    expect(run.sendBack).toEqual({ used: 2, limit: 2 });
  });
});

describe('a Follow-up to a Workflow Run that sent work back', () => {
  it('starts the count again and forgets the review that was owed a re-run', () => {
    const run = sentBack();
    step(run, { kind: 'phase', position: 1 }, {}, 'Fixed.');
    step(run, { kind: 'end' }, changes([{ text: 'Open.' }]));
    run.reportState(
      WORKER,
      { state: 'succeeded', failure: null, delivery: { outcome: 'none' } },
      AT,
    );
    expect(run.sendBacksUsed).toBe(1);

    run.followUp('Try again.', AT, AVAILABLE);

    expect(run.sendBacksUsed).toBe(0);
    expect(run.sendBackReview).toBeNull();
    expect(run.sendBack).toEqual({ used: 0, limit: 2 });
    expect(run.pendingChanges().fields).toMatchObject({ sendBacksUsed: 0, sendBackReview: null });
  });
});
