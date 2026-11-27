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
    resolve: SEQUENTIAL_PLANS.resolve,
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

    expect(asked).toEqual([[WORKFLOW_RECORD, 0, 'done']]);
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
      { resolve, next: plans.next },
    );

    await changed.execute({
      runId,
      workerId: WORKER,
      kind: 'start',
      result: { outcome: 'done', summary: 'Reported.' },
      workingCopy: WORKING_COPY,
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(asked).toEqual([[WORKFLOW_RECORD, 0, 'done']]);
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
      { resolve: plans.resolve, next },
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

describe('ReportRunStepHandler for a review Phase', () => {
  let runs: InMemoryRunRepository;
  let handler: ReportRunStepHandler;
  let asked: Parameters<WorkflowPlans['next']>[];
  let runId: string;
  const SECRET = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';

  const plans: WorkflowPlans = {
    resolve: SEQUENTIAL_PLANS.resolve,
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
