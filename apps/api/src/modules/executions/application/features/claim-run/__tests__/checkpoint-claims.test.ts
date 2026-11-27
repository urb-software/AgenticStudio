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
import type { RunWorkflowData } from '../../../../domain/value-objects/run-workflow.js';
import { ClaimRunHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const OTHER_WORKER = '7a2d3b5f-0c8e-4d4b-9f32-1e6a7b8c9d0e';
const T0 = new Date('2026-11-15T12:00:00.000Z');
const WORKING_COPY = { runBranch: 'studio/run', commits: [], hasUncommittedChanges: true };

const PLAN_THEN_BUILD: RunWorkflowData = {
  ...WORKFLOW_RECORD,
  items: [
    { id: 'plan', kind: 'work', agent: 'builder' },
    { id: 'look', kind: 'checkpoint', text: 'Read the plan.' },
    { id: 'build', kind: 'work', agent: 'polisher', instructions: 'Keep it small.' },
  ],
};

describe('the claims of a Run of a Workflow with a Checkpoint', () => {
  let runs: InMemoryRunRepository;
  let handler: ClaimRunHandler;
  let runId: string;

  const startRun = (record: RunWorkflowData, startsAtCheckpoint?: number) =>
    runs.start({
      projectId: PROJECT,
      provider: 'codex',
      agent: phaseAgent('builder'),
      workflow: {
        record,
        phaseAgents: [phaseAgent('builder'), phaseAgent('polisher', 'claude_code')],
        ...(startsAtCheckpoint === undefined ? {} : { startsAtCheckpoint }),
      },
      task: 'Add a health check',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      limits: { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 },
      integrationBranch: 'dev',
    });

  /** The worker runs the first Phase to its `done` report, which puts the Run at the Checkpoint. */
  async function reachCheckpoint() {
    await runs.change(runId, (run) => {
      run.reportState(WORKER, { state: 'running', failure: null }, T0);
      run.reportStep(
        WORKER,
        {
          kind: 'start',
          index: 1,
          result: { outcome: 'done', summary: 'Planned the endpoint.' },
          sessionRef: 's-1',
        },
        WORKING_COPY,
        [],
        T0,
        { kind: 'checkpoint', item: 1 },
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
  });

  describe('after a Phase', () => {
    beforeEach(async () => {
      runId = (await startRun(PLAN_THEN_BUILD)).id;
    });

    it('does not make the Phase before a Checkpoint the last one: the Run waits, it is not delivered', async () => {
      const claimed = await handler.execute({ workerId: WORKER });

      expect(claimed?.phase).toMatchObject({ position: 0, itemId: 'plan', count: 2, final: false });
    });

    it('hands the Run to no worker while it waits at the Checkpoint', async () => {
      await handler.execute({ workerId: WORKER });
      await reachCheckpoint();

      expect(await handler.execute({ workerId: WORKER })).toBeNull();
      expect(await handler.execute({ workerId: OTHER_WORKER })).toBeNull();
    });

    it('hands the next Phase out with the comment, after what the Phase before reported', async () => {
      await handler.execute({ workerId: WORKER });
      await reachCheckpoint();
      await runs.change(runId, (run) =>
        run.continueFromCheckpoint({ kind: 'phase', position: 1 }, 'Use the small plan.', T0),
      );

      const claimed = await handler.execute({ workerId: WORKER });

      expect(claimed).toMatchObject({
        handOut: { kind: 'next_phase', runBranch: 'studio/run' },
        agent: { name: 'polisher' },
        phase: {
          position: 1,
          itemId: 'build',
          final: true,
          instructions: 'Keep it small.',
          checkpointComment: 'Use the small plan.',
          previous: { itemId: 'plan', summary: 'Planned the endpoint.' },
        },
      });
    });

    it('carries no comment when the operator wrote none', async () => {
      await handler.execute({ workerId: WORKER });
      await reachCheckpoint();
      await runs.change(runId, (run) =>
        run.continueFromCheckpoint({ kind: 'phase', position: 1 }, undefined, T0),
      );

      const claimed = await handler.execute({ workerId: WORKER });

      expect(claimed?.phase).not.toHaveProperty('checkpointComment');
    });

    it('hands the delivery of what exists out, to the worker with the Working copy, once the operator stopped', async () => {
      await handler.execute({ workerId: WORKER });
      await reachCheckpoint();
      await runs.change(runId, (run) => run.stopAtCheckpoint(T0));

      expect(await handler.execute({ workerId: OTHER_WORKER })).toBeNull();
      const claimed = await handler.execute({ workerId: WORKER });

      expect(claimed).toMatchObject({
        id: runId,
        state: 'preparing',
        handOut: { kind: 'deliver', runBranch: 'studio/run' },
        completedSteps: 1,
      });
      expect(claimed).not.toHaveProperty('phase');
      expect(await handler.execute({ workerId: WORKER })).toBeNull();
    });
  });

  describe('before the first Phase', () => {
    it('starts the first Phase as a new Run once the operator continued, with the comment and no hand-over', async () => {
      runId = (
        await startRun(
          {
            ...WORKFLOW_RECORD,
            items: [{ id: 'ready', kind: 'checkpoint', text: 'Ready?' }, ...PLAN_THEN_BUILD.items],
          },
          0,
        )
      ).id;
      expect(await handler.execute({ workerId: WORKER })).toBeNull();
      await runs.change(runId, (run) =>
        run.continueFromCheckpoint({ kind: 'phase', position: 0 }, 'Take care.', T0),
      );

      const claimed = await handler.execute({ workerId: OTHER_WORKER });

      expect(claimed).toMatchObject({
        id: runId,
        handOut: { kind: 'start' },
        phase: { position: 0, itemId: 'plan', checkpointComment: 'Take care.' },
      });
      expect(claimed?.phase).not.toHaveProperty('previous');
    });
  });
});
