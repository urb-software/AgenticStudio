import { beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '../../../../domain/entities/run.js';
import { phaseAgent } from '../../../../domain/entities/__tests__/workflow-run-fixtures.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { CancelLongWaitingRunsHandler } from '../handler.js';

const PROJECTS = [
  '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e',
  '4a3c9d2f-5e6b-4c7d-8e9f-0a1b2c3d4e5f',
] as const;
const WORKER = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';
const T0 = new Date('2026-11-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const later = (days: number, extraMs = 0) => new Date(T0.getTime() + days * DAY_MS + extraMs);

describe('CancelLongWaitingRunsHandler', () => {
  let runs: InMemoryRunRepository;
  let now: Date;
  let handler: CancelLongWaitingRunsHandler;

  async function waiting(projectId: string, waitingDays: number): Promise<Run> {
    const run = await runs.start({
      projectId,
      provider: 'codex',
      task: 'x',
      startCommit: 'a',
      remoteUrl: 'https://git.example.test/a.git',
      integrationBranch: 'dev',
      limits: { stepMinutes: 60, maxSteps: 10, waitingDays, maxTotalSteps: 50 },
    });
    await runs.claimNext(WORKER, T0);
    for (const [from, to] of [
      ['preparing', 'running'],
      ['running', 'waiting_for_operator'],
    ] as const) {
      await runs.transitionClaimed({
        runId: run.id,
        workerId: WORKER,
        from,
        to,
        failure: null,
        cancelRequested: false,
        now: T0,
      });
    }
    return run;
  }

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    now = T0;
    handler = new CancelLongWaitingRunsHandler(runs, { now: () => now });
  });

  it('cancels a Run that waited longer than its waiting period, by the system', async () => {
    const run = await waiting(PROJECTS[0], 14);
    now = later(14, 1);

    expect(await handler.execute()).toEqual({ cancelled: 1 });

    expect((await runs.findById(run.id))!).toMatchObject({
      lifecycle: {
        state: 'cancelled',
        cancellation: {
          by: 'system',
          reason: 'Cancelled automatically: the run waited for the operator longer than 14 days.',
        },
        finishedAt: now,
      },
    });
  });

  it('leaves Runs within their waiting period alone, each by its own limit', async () => {
    const short = await waiting(PROJECTS[0], 1);
    const long = await waiting(PROJECTS[1], 14);
    now = later(2);

    expect(await handler.execute()).toEqual({ cancelled: 1 });

    expect((await runs.findById(short.id))?.lifecycle.state).toBe('cancelled');
    expect((await runs.findById(long.id))?.lifecycle.state).toBe('waiting_for_operator');
  });

  it('cancels nothing when no Run waits', async () => {
    expect(await handler.execute()).toEqual({ cancelled: 0 });
  });

  describe('a Run waiting at a Checkpoint', () => {
    async function atCheckpoint(projectId: string, waitingDays: number): Promise<Run> {
      const planner = phaseAgent('planner');
      const created = await runs.start({
        projectId,
        provider: planner.provider,
        agent: planner,
        workflow: {
          record: {
            name: 'plan-then-build',
            commit: 'c'.repeat(40),
            items: [
              { id: 'plan', kind: 'work', agent: 'planner' },
              { id: 'look', kind: 'checkpoint', text: 'Read the plan.' },
              { id: 'build', kind: 'work', agent: 'builder' },
            ],
          },
          phaseAgents: [planner, phaseAgent('builder')],
        },
        task: 'x',
        startCommit: 'a',
        remoteUrl: 'https://git.example.test/a.git',
        integrationBranch: 'dev',
        limits: { stepMinutes: 60, maxSteps: 10, waitingDays, maxTotalSteps: 50 },
      });
      await runs.claimNext(WORKER, T0);
      await runs.change(created.id, (run) => {
        run.reportState(WORKER, { state: 'running', failure: null }, T0);
        run.reportStep(
          WORKER,
          { kind: 'start', index: 1, result: { outcome: 'done', summary: 'planned' } },
          { runBranch: 'studio/run', commits: [], hasUncommittedChanges: true },
          [],
          T0,
          { kind: 'checkpoint', item: 1 },
        );
      });
      return created;
    }

    it('is cancelled by Studio after the longest waiting time, like one waiting for an Answer', async () => {
      const run = await atCheckpoint(PROJECTS[0], 14);
      now = later(14, 1);

      expect(await handler.execute()).toEqual({ cancelled: 1 });

      const cancelled = (await runs.findById(run.id))!;
      expect(cancelled.lifecycle).toMatchObject({
        state: 'cancelled',
        cancellation: {
          by: 'system',
          reason: 'Cancelled automatically: the run waited for the operator longer than 14 days.',
        },
      });
      expect(cancelled.waiting).toBeNull();
      expect(cancelled.phasePending).toBe(false);
    });

    it('is left alone within the waiting time, and the time counts from the Checkpoint', async () => {
      const run = await atCheckpoint(PROJECTS[0], 14);
      now = later(14);

      expect(await handler.execute()).toEqual({ cancelled: 0 });
      expect((await runs.findById(run.id))?.waiting?.reason).toBe('checkpoint');
    });

    it('is not cancelled once the operator went on, which wins over the sweep', async () => {
      const run = await atCheckpoint(PROJECTS[0], 14);
      await runs.change(run.id, (locked) =>
        locked.continueFromCheckpoint({ kind: 'phase', position: 1 }, undefined, later(13)),
      );
      now = later(15);

      expect(await handler.execute()).toEqual({ cancelled: 0 });
      expect((await runs.findById(run.id))?.lifecycle.state).toBe('queued');
    });
  });
});
