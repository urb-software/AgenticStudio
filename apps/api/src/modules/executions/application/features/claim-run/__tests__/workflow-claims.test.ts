import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { InMemoryRunDiffRepository } from '../../../../domain/repositories/__tests__/in-memory-run-diff-repository.js';
import { InMemoryRunLog } from '../../../ports/__tests__/in-memory-run-log.js';
import { InMemorySecretStore } from '../../../ports/__tests__/in-memory-secret-store.js';
import { FakeProjectKinds } from '../../../ports/__tests__/fake-project-kinds.js';
import { SEQUENTIAL_PLANS } from '../../../ports/__tests__/fake-workflow-plans.js';
import {
  phaseAgent,
  WORKFLOW_RECORD,
} from '../../../../domain/entities/__tests__/workflow-run-fixtures.js';
import { ClaimRunHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const WORKING_COPY = { runBranch: 'studio/run', commits: [], hasUncommittedChanges: true };

describe('the claims of a Run started with a Workflow', () => {
  let runs: InMemoryRunRepository;
  let handler: ClaimRunHandler;
  let runId: string;

  const startWorkflowRun = () =>
    runs.start({
      projectId: PROJECT,
      provider: 'codex',
      agent: phaseAgent('builder'),
      workflow: {
        record: {
          ...WORKFLOW_RECORD,
          items: [
            { id: 'build', kind: 'work', agent: 'builder' },
            { id: 'polish', kind: 'work', agent: 'polisher', instructions: 'Keep it small.' },
          ],
        },
        phaseAgents: [phaseAgent('builder'), phaseAgent('polisher', 'claude_code')],
      },
      task: 'Add a health check',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 },
      integrationBranch: 'dev',
    });

  /** The worker runs the first Phase to its `done` report, which queues the second. */
  async function endFirstPhase(summary = 'Built the endpoint.') {
    await runs.change(runId, (run) => {
      run.reportState(WORKER, { state: 'running', failure: null }, T0);
      run.reportStep(
        WORKER,
        { kind: 'start', index: 1, result: { outcome: 'done', summary }, sessionRef: 's-1' },
        WORKING_COPY,
        [],
        T0,
        { kind: 'phase', position: 1 },
      );
    });
  }

  beforeEach(async () => {
    runs = new InMemoryRunRepository();
    const kinds = new FakeProjectKinds();
    kinds.definitionsId = null;
    handler = new ClaimRunHandler(
      kinds,
      runs,
      new InMemoryRunLog(runs),
      { now: () => T0 },
      { seconds: 60 },
      { forProject: () => Promise.resolve(null) },
      new InMemorySecretStore(),
      { releaseFor: () => Promise.resolve() },
      new InMemoryRunDiffRepository(),
      {
        describe: () => Promise.resolve({ status: 'found', skills: [] }),
        files: () => Promise.reject(new Error('not used')),
      },
      SEQUENTIAL_PLANS,
    );
    runId = (await startWorkflowRun()).id;
  });

  it('starts the first Phase, saying where it is in the Workflow and that more follow', async () => {
    const claimed = await handler.execute({ workerId: WORKER });

    expect(claimed).toMatchObject({
      id: runId,
      handOut: { kind: 'start' },
      agent: { name: 'builder' },
      phase: { position: 0, itemId: 'build', count: 2, final: false },
    });
    expect(claimed?.phase).not.toHaveProperty('previous');
  });

  it('hands the next Phase out as a claim of its own, with what the Phase before reported', async () => {
    await handler.execute({ workerId: WORKER });
    await endFirstPhase();

    const claimed = await handler.execute({ workerId: WORKER });

    expect(claimed).toMatchObject({
      id: runId,
      state: 'preparing',
      provider: 'claude_code',
      agent: { name: 'polisher' },
      sessionRef: null,
      handOut: { kind: 'next_phase', runBranch: 'studio/run' },
      stepsBeforePart: 1,
      completedSteps: 1,
      phase: {
        position: 1,
        itemId: 'polish',
        count: 2,
        final: true,
        instructions: 'Keep it small.',
        previous: { itemId: 'build', agent: 'builder', summary: 'Built the endpoint.' },
      },
    });
  });

  it('cuts what the Phase before reported to the protocol limit, saying so', async () => {
    await handler.execute({ workerId: WORKER });
    await endFirstPhase('x'.repeat(25_000));

    const claimed = await handler.execute({ workerId: WORKER });

    const summary = claimed!.phase!.previous!.summary;
    expect(summary.length).toBeLessThanOrEqual(20_000);
    expect(summary.startsWith('xxx')).toBe(true);
    expect(summary).toContain('[... cut');
  });

  it('hands the next Phase only to the worker that has the Working copy', async () => {
    await handler.execute({ workerId: WORKER });
    await endFirstPhase();

    expect(await handler.execute({ workerId: OTHER_WORKER })).toBeNull();
    expect((await handler.execute({ workerId: WORKER }))?.id).toBe(runId);
  });

  it('keeps the place of the Run between two Phases, so another Run of the Project waits', async () => {
    await handler.execute({ workerId: WORKER });
    await endFirstPhase();
    const other = await runs.start({
      projectId: PROJECT,
      provider: 'codex',
      task: 'Another task',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 },
      integrationBranch: 'dev',
    });

    expect(await handler.execute({ workerId: OTHER_WORKER })).toBeNull();
    expect((await runs.findById(other.id))?.lifecycle.state).toBe('queued');
  });

  it('never has two Phases of one Run claimed at the same time', async () => {
    await handler.execute({ workerId: WORKER });
    await endFirstPhase();
    expect((await handler.execute({ workerId: WORKER }))?.id).toBe(runId);

    expect(await handler.execute({ workerId: WORKER })).toBeNull();
    expect(await handler.execute({ workerId: OTHER_WORKER })).toBeNull();
  });

  it('fails the Run instead of starting a Phase beyond the total of Run steps', async () => {
    runs = new InMemoryRunRepository();
    const limited = await runs.start({
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
      limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 1 },
      integrationBranch: 'dev',
    });
    runId = limited.id;
    const own = new ClaimRunHandler(
      new FakeProjectKinds(),
      runs,
      new InMemoryRunLog(runs),
      { now: () => T0 },
      { seconds: 60 },
      { forProject: () => Promise.resolve(null) },
      new InMemorySecretStore(),
      { releaseFor: () => Promise.resolve() },
      new InMemoryRunDiffRepository(),
      {
        describe: () => Promise.resolve({ status: 'found', skills: [] }),
        files: () => Promise.reject(new Error('not used')),
      },
      SEQUENTIAL_PLANS,
    );
    await own.execute({ workerId: WORKER });
    await endFirstPhase();

    expect(await own.execute({ workerId: WORKER })).toBeNull();

    expect((await runs.findById(limited.id))?.lifecycle).toMatchObject({
      state: 'failed',
      failure: { code: 'step_limit' },
    });
  });

  it('claims a Run started with an agent without a Phase', async () => {
    runs = new InMemoryRunRepository();
    const plain = await runs.start({
      projectId: PROJECT,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 },
      integrationBranch: 'dev',
    });
    const solo = new ClaimRunHandler(
      new FakeProjectKinds(),
      runs,
      new InMemoryRunLog(runs),
      { now: () => T0 },
      { seconds: 60 },
      { forProject: () => Promise.resolve(null) },
      new InMemorySecretStore(),
      { releaseFor: () => Promise.resolve() },
      new InMemoryRunDiffRepository(),
      {
        describe: () => Promise.resolve({ status: 'found', skills: [] }),
        files: () => Promise.reject(new Error('not used')),
      },
      SEQUENTIAL_PLANS,
    );

    const claimed = await solo.execute({ workerId: WORKER });

    expect(claimed?.id).toBe(plain.id);
    expect(claimed).not.toHaveProperty('phase');
  });

  it('says of a review Phase that it is one, and that both Verdicts end the Workflow here', async () => {
    runId = (
      await runs.start({
        projectId: '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f',
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
        task: 'Add a health check',
        startCommit: 'a',
        remoteUrl: 'https://git.example.test/a.git',
        limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 },
        integrationBranch: 'dev',
      })
    ).id;
    await handler.execute({ workerId: WORKER });
    await handler.execute({ workerId: WORKER });
    await runs.change(runId, (run) => {
      run.reportState(WORKER, { state: 'running', failure: null }, T0);
      run.reportStep(
        WORKER,
        { kind: 'start', index: 1, result: { outcome: 'done', summary: 'Built.' } },
        WORKING_COPY,
        [],
        T0,
        { kind: 'phase', position: 1 },
      );
    });

    const claimed = await handler.execute({ workerId: WORKER });

    expect(claimed?.phase).toMatchObject({
      position: 1,
      itemId: 'check',
      kind: 'review',
      final: true,
      endsOnChangesRequested: true,
    });
  });

  it('says of a work Phase that it is one, without a word about a Verdict', async () => {
    const claimed = await handler.execute({ workerId: WORKER });

    expect(claimed?.phase).toMatchObject({ kind: 'work' });
    expect(claimed?.phase).not.toHaveProperty('endsOnChangesRequested');
  });
});
