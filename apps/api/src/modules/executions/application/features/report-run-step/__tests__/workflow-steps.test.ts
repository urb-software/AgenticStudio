import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowPlans } from '../../../../contracts/index.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import {
  phaseAgent,
  WORKFLOW_RECORD,
} from '../../../../domain/entities/__tests__/workflow-run-fixtures.js';
import { ReviewVerdictMissingError } from '../../../../domain/errors/run-errors.js';
import { SEQUENTIAL_PLANS } from '../../../ports/__tests__/fake-workflow-plans.js';
import { ReportRunStepHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const WORKING_COPY = {
  runBranch: 'studio/run',
  commits: [],
  hasUncommittedChanges: true,
};
const LIMITS = { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 };

describe('ReportRunStepHandler for a Run started with a Workflow', () => {
  let runs: InMemoryRunRepository;
  let handler: ReportRunStepHandler;
  let asked: Parameters<WorkflowPlans['next']>[];
  let runId: string;

  const plans: WorkflowPlans = {
    ...SEQUENTIAL_PLANS,
    next: (...args) => {
      asked.push(args);
      return SEQUENTIAL_PLANS.next(...args);
    },
  };

  const claimAndRun = async (id: string) => {
    await runs.claimNext(WORKER, T0);
    await runs.change(id, (run) =>
      run.reportState(WORKER, { state: 'running', failure: null }, T0),
    );
  };

  const report = (id: string, outcome: 'done' | 'needs_input' = 'done', index?: number) =>
    handler.execute({
      runId: id,
      workerId: WORKER,
      kind: 'start',
      ...(index === undefined ? {} : { index }),
      result: {
        outcome,
        summary: 'Reported.',
        ...(outcome === 'needs_input'
          ? { question: { text: 'Which one?' }, sessionRef: 'session-q' }
          : { sessionRef: 'session-1' }),
      },
      workingCopy: WORKING_COPY,
    });

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    asked = [];
    handler = new ReportRunStepHandler(
      runs,
      { now: () => T0 },
      { forRun: () => Promise.resolve([]) },
      plans,
    );
    runId = (
      await runs.start({
        projectId: PROJECT,
        provider: 'codex',
        agent: phaseAgent('builder'),
        workflow: {
          record: WORKFLOW_RECORD,
          phaseAgents: [
            phaseAgent('builder'),
            phaseAgent('polisher', 'claude_code'),
            phaseAgent('finisher'),
          ],
        },
        task: 'x',
        startCommit: 'a',
        remoteUrl: 'https://git.example.test/a.git',
        limits: LIMITS,
        integrationBranch: 'dev',
      })
    ).id;
    await claimAndRun(runId);
  });

  it('asks the Workflow what follows a Phase that is done, with the plan the Run recorded', async () => {
    await report(runId);

    expect(asked).toEqual([
      [{ ...WORKFLOW_RECORD, sendBacks: 2 }, 0, 'done', { used: 0, returnTo: null }],
    ]);
  });

  it('uses the plan the Run recorded when the Workflow was changed or removed after the start', async () => {
    const resolve = vi.fn(() =>
      Promise.resolve({
        status: 'resolved' as const,
        plan: {
          name: 'build-and-polish',
          commit: 'd'.repeat(40),
          items: [{ id: 'only', kind: 'work' as const, agent: 'other' }],
        },
      }),
    );
    const changed = new ReportRunStepHandler(
      runs,
      { now: () => T0 },
      { forRun: () => Promise.resolve([]) },
      { ...plans, resolve },
    );

    await changed.execute({
      runId,
      workerId: WORKER,
      kind: 'start',
      result: { outcome: 'done', summary: 'Reported.' },
      workingCopy: WORKING_COPY,
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(asked).toEqual([
      [{ ...WORKFLOW_RECORD, sendBacks: 2 }, 0, 'done', { used: 0, returnTo: null }],
    ]);
    expect((await runs.findById(runId))?.currentPhase).toBe(1);
  });

  it('moves the Run to the Phase the Workflow names, saving the result with the Phase it ended', async () => {
    await report(runId);

    const run = (await runs.findById(runId))!;
    expect(run).toMatchObject({ currentPhase: 1, phasePending: true });
    expect(run.lifecycle.state).toBe('queued');
    expect(run.phases.map((phase) => [phase.state, phase.summary, phase.sessionRef])).toEqual([
      ['done', 'Reported.', 'session-1'],
      ['pending', null, null],
      ['pending', null, null],
    ]);
    expect(runs.steps.map((step) => step.index)).toEqual([1]);
  });

  it('does not ask when the step ends with a question: the Run waits in the same Phase', async () => {
    await report(runId, 'needs_input');

    expect(asked).toEqual([]);
    const run = (await runs.findById(runId))!;
    expect(run).toMatchObject({ currentPhase: 0, phasePending: false });
    expect(run.claim.sessionRef).toBe('session-q');
  });

  it('acknowledges the report of the Phase that ended when it is sent again', async () => {
    await report(runId, 'done', 1);

    expect(await report(runId, 'done', 1)).toEqual({ index: 1 });
    expect((await runs.findById(runId))?.currentPhase).toBe(1);
  });

  it('never asks the Workflow for a Run started with an agent', async () => {
    const next = vi.fn(plans.next);
    const lone = new ReportRunStepHandler(
      runs,
      { now: () => T0 },
      { forRun: () => Promise.resolve([]) },
      { ...plans, next },
    );
    const plain = await runs.start({
      projectId: '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f',
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: LIMITS,
      integrationBranch: 'dev',
    });
    await claimAndRun(plain.id);

    await lone.execute({
      runId: plain.id,
      workerId: WORKER,
      kind: 'start',
      result: { outcome: 'done', summary: 'Done.' },
      workingCopy: WORKING_COPY,
    });

    expect(next).not.toHaveBeenCalled();
    expect((await runs.findById(plain.id))?.lifecycle.state).toBe('running');
  });
});

describe('ReportRunStepHandler for a Workflow with a Checkpoint', () => {
  const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
  let runs: InMemoryRunRepository;
  let handler: ReportRunStepHandler;
  let runId: string;

  const report = (index?: number) =>
    handler.execute({
      runId,
      workerId: WORKER,
      kind: 'start',
      ...(index === undefined ? {} : { index }),
      result: { outcome: 'done', summary: 'Planned.', sessionRef: 'session-1' },
      workingCopy: WORKING_COPY,
    });

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    handler = new ReportRunStepHandler(
      runs,
      { now: () => T0 },
      { forRun: () => Promise.resolve([]) },
      SEQUENTIAL_PLANS,
    );
    runId = (
      await runs.start({
        projectId: PROJECT,
        provider: 'codex',
        agent: phaseAgent('builder'),
        workflow: {
          record: {
            ...WORKFLOW_RECORD,
            items: [
              { id: 'plan', kind: 'work', agent: 'builder' },
              { id: 'look', kind: 'checkpoint', text: 'Read the plan.' },
              { id: 'build', kind: 'work', agent: 'polisher' },
            ],
          },
          phaseAgents: [phaseAgent('builder'), phaseAgent('polisher', 'claude_code')],
        },
        task: 'x',
        startCommit: 'a',
        remoteUrl: 'https://git.example.test/a.git',
        limits: LIMITS,
        integrationBranch: 'dev',
      })
    ).id;
    await runs.claimNext(WORKER, T0);
    await runs.change(runId, (run) =>
      run.reportState(WORKER, { state: 'running', failure: null }, T0),
    );
  });

  it('stores the result and puts the Run at the Checkpoint in the same change', async () => {
    await report();

    const run = (await runs.findById(runId))!;
    expect(run.lifecycle.state).toBe('waiting_for_operator');
    expect(run.waiting).toEqual({
      reason: 'checkpoint',
      checkpoint: { id: 'look', text: 'Read the plan.' },
    });
    expect(run).toMatchObject({ currentPhase: 0, phasePending: false });
    expect(run.phases.map((phase) => [phase.state, phase.summary])).toEqual([
      ['done', 'Planned.'],
      ['pending', null],
    ]);
    expect(runs.steps.map((step) => step.index)).toEqual([1]);
  });

  it('does not pass the Checkpoint for an agent: the result, sent again, changes nothing, and no worker gets the Run', async () => {
    await report(1);
    await report(1);

    const run = (await runs.findById(runId))!;
    expect(run.lifecycle.state).toBe('waiting_for_operator');
    expect(run).toMatchObject({ currentPhase: 0, phasePending: false });
    expect(await runs.claimNext(WORKER, T0)).toBeNull();
    expect(await runs.claimNext(OTHER_WORKER, T0)).toBeNull();
  });

  it('refuses a further result, from the worker that ended the Phase or any other, once the Run waits', async () => {
    await report(1);

    await expect(report(2)).rejects.toThrow();
    await expect(
      handler.execute({
        runId,
        workerId: OTHER_WORKER,
        kind: 'start',
        result: { outcome: 'done', summary: 'Skipping.' },
        workingCopy: WORKING_COPY,
      }),
    ).rejects.toThrow();
    expect((await runs.findById(runId))!.waiting?.reason).toBe('checkpoint');
  });
});

describe('ReportRunStepHandler for a review Phase', () => {
  let runs: InMemoryRunRepository;
  let handler: ReportRunStepHandler;
  let asked: Parameters<WorkflowPlans['next']>[];
  let runId: string;
  const SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';

  const plans: WorkflowPlans = {
    ...SEQUENTIAL_PLANS,
    next: (...args) => {
      asked.push(args);
      return SEQUENTIAL_PLANS.next(...args);
    },
  };

  const claimAndRun = async () => {
    await runs.claimNext(WORKER, T0);
    await runs.change(runId, (run) =>
      run.reportState(WORKER, { state: 'running', failure: null }, T0),
    );
  };

  const report = (
    index: number,
    extra: Partial<Parameters<ReportRunStepHandler['execute']>[0]['result']> = {},
  ) =>
    handler.execute({
      runId,
      workerId: WORKER,
      kind: 'start',
      index,
      result: { outcome: 'done', summary: 'Reported.', sessionRef: `s-${index}`, ...extra },
      workingCopy: WORKING_COPY,
    });

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    asked = [];
    handler = new ReportRunStepHandler(
      runs,
      { now: () => T0 },
      { forRun: () => Promise.resolve([SECRET]) },
      plans,
    );
    runId = (
      await runs.start({
        projectId: PROJECT,
        provider: 'codex',
        agent: phaseAgent('builder'),
        workflow: {
          record: {
            ...WORKFLOW_RECORD,
            items: [
              { id: 'build', kind: 'work', agent: 'builder' },
              { id: 'check', kind: 'review', agent: 'reviewer' },
            ],
            // No send-back: changes requested end the Workflow, as the tests below describe.
            sendBacks: 0,
          },
          phaseAgents: [phaseAgent('builder'), phaseAgent('reviewer', 'claude_code')],
        },
        task: 'x',
        startCommit: 'a',
        remoteUrl: 'https://git.example.test/a.git',
        limits: LIMITS,
        integrationBranch: 'dev',
      })
    ).id;
    await claimAndRun();
    await report(1);
    await claimAndRun();
  });

  it('asks what follows with the Verdict, and stores the Verdict and the findings redacted', async () => {
    await report(2, {
      verdict: 'changes_requested',
      findings: [{ text: `Leaks ${SECRET}.`, file: 'src/a.ts', line: 4 }, { text: 'Second.' }],
    });

    expect(asked.at(-1)?.[1]).toBe(1);
    expect(asked.at(-1)?.[2]).toBe('changes_requested');
    const run = (await runs.findById(runId))!;
    expect(run.reviewNotPassed).toBe(true);
    expect(run.phases[1]).toMatchObject({
      verdict: 'changes_requested',
      findings: [
        { text: expect.not.stringContaining(SECRET), file: 'src/a.ts', line: 4 },
        { text: 'Second.' },
      ],
    });
  });

  it('asks with approved for an approval, which also ends this Workflow', async () => {
    await report(2, { verdict: 'approved' });

    expect(asked.at(-1)?.[2]).toBe('approved');
    const run = (await runs.findById(runId))!;
    expect(run.reviewNotPassed).toBe(false);
    expect(run.phases[1]).toMatchObject({ verdict: 'approved', findings: [] });
  });

  it('fails the Run, asking nothing, when a review Phase is done without a Verdict', async () => {
    const before = asked.length;

    await expect(report(2)).rejects.toBeInstanceOf(ReviewVerdictMissingError);

    expect(asked.length).toBe(before);
    const run = (await runs.findById(runId))!;
    expect(run.lifecycle.state).toBe('failed');
    expect(run.lifecycle.failure?.code).toBe('agent_failed');
  });

  it('ignores a Verdict that a work Phase reports', async () => {
    runs = new InMemoryRunRepository();
    handler = new ReportRunStepHandler(
      runs,
      { now: () => T0 },
      { forRun: () => Promise.resolve([]) },
      plans,
    );
    runId = (
      await runs.start({
        projectId: PROJECT,
        provider: 'codex',
        agent: phaseAgent('builder'),
        workflow: {
          record: WORKFLOW_RECORD,
          phaseAgents: [phaseAgent('builder'), phaseAgent('polisher'), phaseAgent('finisher')],
        },
        task: 'x',
        startCommit: 'a',
        remoteUrl: 'https://git.example.test/a.git',
        limits: LIMITS,
        integrationBranch: 'dev',
      })
    ).id;
    await claimAndRun();
    asked = [];

    await report(1, { verdict: 'changes_requested', findings: [{ text: 'Not a review.' }] });

    expect(asked.at(-1)?.[2]).toBe('done');
    const run = (await runs.findById(runId))!;
    expect(run.reviewNotPassed).toBe(false);
    expect(run.phases[0]).toMatchObject({ verdict: null, findings: [], state: 'done' });
    expect(run.currentPhase).toBe(1);
    expect(JSON.stringify(runs.steps)).not.toContain('Not a review');
  });
});

describe('ReportRunStepHandler for a review that asks for changes', () => {
  let runs: InMemoryRunRepository;
  let handler: ReportRunStepHandler;
  let asked: Parameters<WorkflowPlans['next']>[];
  let runId: string;
  const SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';

  const plans: WorkflowPlans = {
    ...SEQUENTIAL_PLANS,
    next: (...args) => {
      asked.push(args);
      return SEQUENTIAL_PLANS.next(...args);
    },
  };

  const claimAndRun = async () => {
    await runs.claimNext(WORKER, T0);
    await runs.change(runId, (run) =>
      run.reportState(WORKER, { state: 'running', failure: null }, T0),
    );
  };

  const report = (extra: Partial<Parameters<ReportRunStepHandler['execute']>[0]['result']> = {}) =>
    handler.execute({
      runId,
      workerId: WORKER,
      kind: 'start',
      result: { outcome: 'done', summary: 'Reported.', sessionRef: 's-x', ...extra },
      workingCopy: WORKING_COPY,
    });

  const changes = (text: string) =>
    report({ verdict: 'changes_requested', findings: [{ text, file: 'src/a.ts', line: 4 }] });

  const start = async (sendBacks?: number) => {
    runId = (
      await runs.start({
        projectId: PROJECT,
        provider: 'codex',
        agent: phaseAgent('builder'),
        workflow: {
          record: {
            ...WORKFLOW_RECORD,
            items: [
              { id: 'build', kind: 'work', agent: 'builder' },
              { id: 'check', kind: 'review', agent: 'reviewer' },
            ],
            ...(sendBacks === undefined ? {} : { sendBacks }),
          },
          phaseAgents: [phaseAgent('builder'), phaseAgent('reviewer', 'claude_code')],
        },
        task: 'x',
        startCommit: 'a',
        remoteUrl: 'https://git.example.test/a.git',
        limits: LIMITS,
        integrationBranch: 'dev',
      })
    ).id;
    await claimAndRun();
    await report();
    await claimAndRun();
  };

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    asked = [];
    handler = new ReportRunStepHandler(
      runs,
      { now: () => T0 },
      { forRun: () => Promise.resolve([SECRET]) },
      plans,
    );
  });

  it('asks with the count the Run has used, and sends the work back while the limit allows it', async () => {
    await start();

    await changes('Needs a test.');

    expect(asked.at(-1)).toEqual([
      expect.objectContaining({ sendBacks: 2 }),
      1,
      'changes_requested',
      { used: 0, returnTo: null },
    ]);
    const run = (await runs.findById(runId))!;
    expect(run).toMatchObject({ currentPhase: 0, phasePending: true, sendBacksUsed: 1 });
    expect(run.lifecycle.state).toBe('queued');
    expect(run.reviewNotPassed).toBe(false);
  });

  it('keeps the findings of the round, redacted, with the review Phase', async () => {
    await start();

    await changes(`Leaks ${SECRET}.`);

    const run = (await runs.findById(runId))!;
    const [round] = run.phases[1]!.rounds;
    expect(round).toMatchObject({ round: 1, verdict: 'changes_requested' });
    expect(round!.findings[0]).toMatchObject({ file: 'src/a.ts', line: 4 });
    expect(round!.findings[0]!.text).not.toContain(SECRET);
    expect(JSON.stringify(runs.steps)).not.toContain(SECRET);
  });

  it('asks the Workflow to return to the review once the work Phase is done again', async () => {
    await start();
    await changes('Needs a test.');
    await claimAndRun();

    await report();

    expect(asked.at(-1)).toEqual([expect.anything(), 0, 'done', { used: 1, returnTo: 1 }]);
    expect((await runs.findById(runId))!.currentPhase).toBe(1);
  });

  it('ends the Workflow as "review not passed" at the limit, with the open findings of the last review', async () => {
    await start(1);
    await changes('First.');
    await claimAndRun();
    await report();
    await claimAndRun();

    await changes('Still open.');

    const run = (await runs.findById(runId))!;
    expect(run.reviewNotPassed).toBe(true);
    expect(run).toMatchObject({ sendBacksUsed: 1, phasePending: false });
    expect(run.phases[1]!.findings).toMatchObject([{ text: 'Still open.' }]);
    expect(run.lifecycle.state).toBe('running');
  });

  it('takes the limit from the recorded plan alone: a Run with no number has two, never more', async () => {
    await start();
    for (const round of ['one', 'two']) {
      await changes(round);
      await claimAndRun();
      await report();
      await claimAndRun();
    }

    await changes('three');

    const run = (await runs.findById(runId))!;
    expect(run.sendBacksUsed).toBe(2);
    expect(run.reviewNotPassed).toBe(true);
    expect(run.phasePending).toBe(false);
  });
});
