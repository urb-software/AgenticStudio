import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Run } from '../../../domain/entities/run.js';
import { RunNotAtCheckpointError, RunSlotTakenError } from '../../../domain/errors/run-errors.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import type { RunWorkflowData } from '../../../domain/value-objects/run-workflow.js';
import { Task } from '../../../domain/value-objects/task.js';
import {
  phaseAgent,
  WORKFLOW_COMMIT,
} from '../../../domain/entities/__tests__/workflow-run-fixtures.js';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../../platform/database/database.module.js';
import {
  startStudioApp,
  startStudioServices,
  type StudioServices,
} from '../../../../../__tests__/studio-test-app.js';

const NOW = new Date('2026-11-27T12:00:00.000Z');
const LATER = new Date('2026-11-27T13:00:00.000Z');
const WORKER = randomUUID();
const OTHER_WORKER = randomUUID();
const WORKING_COPY = { runBranch: 'run/x', commits: [], hasUncommittedChanges: true };
const LIMITS = { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 };

/** Phase, Checkpoint, Phase. */
const RECORD: RunWorkflowData = {
  name: 'plan-then-build',
  commit: WORKFLOW_COMMIT,
  items: [
    { id: 'plan', kind: 'work', agent: 'planner' },
    { id: 'look', kind: 'checkpoint', text: 'Read the plan.' },
    { id: 'build', kind: 'work', agent: 'builder' },
  ],
};

describe('a Run waiting at a Checkpoint is stored, moved and refused as the contract says (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const runs = () => app.get<RunRepository>(RUN_REPOSITORY);

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(services.config);
  });

  // Claims pick the oldest eligible Run of the server, so each case starts with none.
  beforeEach(async () => {
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  async function project(): Promise<string> {
    const name = `Shop ${randomUUID()}`;
    const [row] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    return row!.id;
  }

  async function started(
    projectId: string,
    record: RunWorkflowData = RECORD,
    startsAtCheckpoint?: number,
  ): Promise<string> {
    const planner = phaseAgent('planner');
    const phaseAgents = record.items.flatMap((item) =>
      item.kind === 'checkpoint' ? [] : [phaseAgent(item.agent)],
    );
    const run = await runs().add(
      Run.start({
        id: randomUUID(),
        projectId,
        provider: planner.provider,
        agent: planner,
        workflow: {
          record,
          phaseAgents,
          ...(startsAtCheckpoint === undefined ? {} : { startsAtCheckpoint }),
        },
        task: Task.of('Add a health check'),
        startCommit: 'a'.repeat(40),
        remoteUrl: 'https://git.example.test/acme/shop.git',
        integrationBranch: 'dev',
        limits: LIMITS,
        now: NOW,
      }),
    );
    return run.id;
  }

  /** The first Phase runs to its `done` report, which puts the Run at the Checkpoint. */
  async function reachCheckpoint(id: string): Promise<void> {
    expect((await runs().claimNext(WORKER, NOW))?.id).toBe(id);
    await runs().change(id, (run) => {
      run.reportState(WORKER, { state: 'running', failure: null }, NOW);
      run.reportStep(
        WORKER,
        {
          kind: 'start',
          index: 1,
          result: { outcome: 'done', summary: 'Planned.' },
          sessionRef: 'session-1',
        },
        WORKING_COPY,
        [],
        NOW,
        { kind: 'checkpoint', item: 1 },
      );
    });
  }

  const goOn = (id: string, comment?: string) =>
    runs().change(id, (run) => {
      run.assertAtCheckpoint('look');
      run.continueFromCheckpoint({ kind: 'phase', position: 1 }, comment, LATER);
    });

  const row = async (id: string) =>
    (
      await db().$queryRaw<
        {
          state: string;
          checkpoint_item: number | null;
          workflow_ended: boolean;
          phase_pending: boolean;
          current_phase: number;
          waiting_since: Date | null;
          claimed_by: string | null;
          delivery: string | null;
        }[]
      >`
        SELECT state, checkpoint_item, workflow_ended, phase_pending, current_phase, waiting_since,
               claimed_by, delivery
        FROM runs WHERE id = ${id}::uuid`
    )[0]!;

  const comments = (id: string) =>
    db().$queryRaw<{ position: number; checkpoint_comment: string | null }[]>`
      SELECT position, checkpoint_comment FROM run_phases
      WHERE run_id = ${id}::uuid ORDER BY position`;

  it('waits for the operator with the place of the Checkpoint, in the change that stores the result', async () => {
    const id = await started(await project());

    await reachCheckpoint(id);

    expect(await row(id)).toMatchObject({
      state: 'waiting_for_operator',
      checkpoint_item: 1,
      phase_pending: false,
      current_phase: 0,
      claimed_by: null,
    });
    expect((await row(id)).waiting_since).not.toBeNull();
    const run = (await runs().findById(id))!;
    expect(run.waiting).toEqual({
      reason: 'checkpoint',
      checkpoint: { id: 'look', text: 'Read the plan.' },
    });
    expect(run.phases.map((phase) => [phase.state, phase.summary])).toEqual([
      ['done', 'Planned.'],
      ['pending', null],
    ]);
    expect(await runs().claimNext(WORKER, NOW)).toBeNull();
    expect(await runs().claimNext(OTHER_WORKER, NOW)).toBeNull();
  });

  it('shows where a Run waits in a list of Runs, without reading its conversation', async () => {
    const id = await started(await project());
    await reachCheckpoint(id);

    const listed = (await runs().listNewestFirst()).find((run) => run.id === id)!;

    expect(listed.waiting).toEqual({
      reason: 'checkpoint',
      checkpoint: { id: 'look', text: 'Read the plan.' },
    });
  });

  it('refuses, by a CHECK, a Checkpoint place on a Run that does not wait', async () => {
    const id = await started(await project());

    await expect(
      db().$executeRaw`UPDATE runs SET checkpoint_item = 1 WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/runs_checkpoint_check/);
    await reachCheckpoint(id);
    await expect(
      db().$executeRaw`UPDATE runs SET state = 'queued' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/runs_checkpoint_check/);
  });

  it('queues the next Phase when the operator continues, with the comment kept on that Phase', async () => {
    const id = await started(await project());
    await reachCheckpoint(id);

    await goOn(id, 'Use the small plan.');

    expect(await row(id)).toMatchObject({
      state: 'queued',
      checkpoint_item: null,
      phase_pending: true,
      current_phase: 1,
      waiting_since: null,
    });
    expect(await comments(id)).toEqual([
      { position: 0, checkpoint_comment: null },
      { position: 1, checkpoint_comment: 'Use the small plan.' },
    ]);
    expect(await runs().claimNext(OTHER_WORKER, NOW)).toBeNull();
    const claimed = (await runs().claimNext(WORKER, NOW))!;
    expect(claimed.id).toBe(id);
    expect(claimed.handOut()).toMatchObject({ kind: 'next_phase', runBranch: 'run/x' });
    expect(claimed.phases[1]!.checkpointComment).toBe('Use the small plan.');
  });

  it('lets only one of two simultaneous Continue requests pass, and starts one Phase', async () => {
    const id = await started(await project());
    await reachCheckpoint(id);

    const results = await Promise.allSettled([goOn(id, 'one'), goOn(id, 'two')]);

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((result) => result.status === 'rejected')!;
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(RunNotAtCheckpointError);
    expect(await row(id)).toMatchObject({ state: 'queued', current_phase: 1, phase_pending: true });
    const kept = await comments(id);
    expect(kept[1]!.checkpoint_comment).toMatch(/^(one|two)$/);
  });

  it('refuses a Continue after the Run was cancelled, and a cancel while it waits writes nothing else', async () => {
    const id = await started(await project());
    await reachCheckpoint(id);
    await runs().change(id, (run) => run.cancel(LATER));

    await expect(goOn(id)).rejects.toBeInstanceOf(RunNotAtCheckpointError);

    expect(await row(id)).toMatchObject({
      state: 'cancelled',
      checkpoint_item: null,
      phase_pending: false,
      current_phase: 0,
    });
    expect(await comments(id)).toEqual([
      { position: 0, checkpoint_comment: null },
      { position: 1, checkpoint_comment: null },
    ]);
    expect(await runs().claimNext(WORKER, NOW)).toBeNull();
  });

  it('is cancelled by the sweep after the longest waiting time, and not before the Run waited that long', async () => {
    const id = await started(await project());
    await reachCheckpoint(id);

    const waiting = (await runs().listWaiting()).find((run) => run.id === id);
    expect(waiting?.sweepFacts()).toMatchObject({
      state: 'waiting_for_operator',
      waitingSince: expect.any(Date),
    });
    await runs().change(id, (run) =>
      run.cancelAfterWaiting(
        { by: 'system', reason: 'Cancelled automatically: waited too long.' } as never,
        LATER,
      ),
    );

    expect(await row(id)).toMatchObject({ state: 'cancelled', checkpoint_item: null });
  });

  it('delivers once, to the worker with the Working copy, when the operator stops, and finishes', async () => {
    const id = await started(await project());
    await reachCheckpoint(id);
    await runs().change(id, (run) => {
      run.assertAtCheckpoint('look');
      run.stopAtCheckpoint(LATER);
    });

    expect(await row(id)).toMatchObject({
      state: 'queued',
      workflow_ended: true,
      phase_pending: true,
      checkpoint_item: null,
      current_phase: 0,
    });
    expect(await runs().claimNext(OTHER_WORKER, NOW)).toBeNull();
    const claimed = (await runs().claimNext(WORKER, NOW))!;
    expect(claimed.handOut()).toEqual({ kind: 'deliver', runBranch: 'run/x' });
    await runs().change(id, (run) =>
      run.reportState(
        WORKER,
        {
          state: 'succeeded',
          failure: null,
          delivery: { outcome: 'none' },
          workingCopy: WORKING_COPY,
        },
        LATER,
      ),
    );

    expect(await row(id)).toMatchObject({
      state: 'succeeded',
      delivery: 'none',
      phase_pending: false,
      workflow_ended: true,
    });
    await expect(runs().change(id, (run) => run.stopAtCheckpoint(LATER))).rejects.toBeInstanceOf(
      RunNotAtCheckpointError,
    );
    expect(await runs().claimNext(WORKER, NOW)).toBeNull();
  });

  describe('a Workflow that starts at a Checkpoint', () => {
    const FIRST: RunWorkflowData = {
      ...RECORD,
      items: [{ id: 'ready', kind: 'checkpoint', text: 'Ready?' }, ...RECORD.items.slice(0, 1)],
    };

    it('is stored waiting, with no Working copy, and is handed to no worker', async () => {
      const id = await started(await project(), FIRST, 0);

      expect(await row(id)).toMatchObject({
        state: 'waiting_for_operator',
        checkpoint_item: 0,
        claimed_by: null,
      });
      expect((await row(id)).waiting_since).not.toBeNull();
      expect(await runs().claimNext(WORKER, NOW)).toBeNull();
    });

    it('refuses to start while another Run of the Project is active, which holds the place', async () => {
      const projectId = await project();
      await started(projectId, FIRST, 0);

      await expect(started(projectId, FIRST, 0)).rejects.toBeInstanceOf(RunSlotTakenError);
    });

    it('starts its first Phase as a new Run when the operator continues', async () => {
      const id = await started(await project(), FIRST, 0);

      await runs().change(id, (run) =>
        run.continueFromCheckpoint({ kind: 'phase', position: 0 }, 'Take care.', LATER),
      );

      expect(await row(id)).toMatchObject({ state: 'queued', checkpoint_item: null });
      const claimed = (await runs().claimNext(OTHER_WORKER, NOW))!;
      expect(claimed.id).toBe(id);
      expect(claimed.handOut()).toEqual({ kind: 'start' });
      expect(claimed.phases[0]!.checkpointComment).toBe('Take care.');
    });

    it('finishes without a pull request when the operator stops', async () => {
      const id = await started(await project(), FIRST, 0);

      await runs().change(id, (run) => run.stopAtCheckpoint(LATER));

      expect(await row(id)).toMatchObject({
        state: 'succeeded',
        delivery: 'none',
        checkpoint_item: null,
      });
    });
  });
});
