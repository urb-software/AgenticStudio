import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Run } from '../../../domain/entities/run.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { Task } from '../../../domain/value-objects/task.js';
import {
  phaseAgent,
  WORKFLOW_RECORD,
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
const WORKER = randomUUID();
const OTHER_WORKER = randomUUID();
const WORKING_COPY = { runBranch: 'run/x', commits: [], hasUncommittedChanges: true };
const LIMITS = { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 };

describe('a Run started with a Workflow is stored and moved by Phase (PostgreSQL + Redis via Testcontainers)', () => {
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

  async function started(projectId: string): Promise<string> {
    const builder = phaseAgent('builder');
    const run = await runs().add(
      Run.start({
        id: randomUUID(),
        projectId,
        provider: builder.provider,
        agent: builder,
        workflow: {
          record: WORKFLOW_RECORD,
          phaseAgents: [builder, phaseAgent('polisher', 'claude_code'), phaseAgent('finisher')],
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

  async function runPhase(
    id: string,
    index: number,
    next: Parameters<Run['reportStep']>[5],
  ): Promise<void> {
    const claimed = await runs().claimNext(WORKER, NOW);
    expect(claimed?.id).toBe(id);
    await runs().change(id, (run) => {
      run.reportState(WORKER, { state: 'running', failure: null }, NOW);
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
        NOW,
        next,
      );
    });
  }

  const phaseRows = (id: string) =>
    db().$queryRaw<
      {
        position: number;
        item_id: string | null;
        kind: string;
        state: string;
        agent_provider: string;
        session_ref: string | null;
        summary: string | null;
        steps_before_part: number;
        steps: number;
      }[]
    >`
      SELECT p.position, p.item_id, p.kind, p.state, p.agent_provider, p.session_ref, p.summary,
             p.steps_before_part,
             (SELECT count(*)::int FROM run_steps s WHERE s.phase_id = p.id) AS steps
      FROM run_phases p WHERE p.run_id = ${id}::uuid ORDER BY p.position`;

  const runColumns = async (id: string) => {
    const [row] = await db().$queryRaw<
      {
        state: string;
        provider: string;
        current_phase: number;
        has_session: boolean;
        phase_pending: boolean;
        claimed_by: string | null;
        workflow_name: string | null;
        workflow_commit: string | null;
        items: number | null;
      }[]
    >`
      SELECT state, provider, current_phase, has_session, phase_pending, claimed_by,
             workflow_name, workflow_commit, jsonb_array_length(workflow_items) AS items
      FROM runs WHERE id = ${id}::uuid`;
    return row!;
  };

  it('records the Workflow and one pending Phase per item, each with its agent', async () => {
    const id = await started(await project());

    expect(await runColumns(id)).toMatchObject({
      state: 'queued',
      provider: 'codex',
      current_phase: 0,
      phase_pending: false,
      workflow_name: 'build-and-polish',
      workflow_commit: 'c'.repeat(40),
      items: 3,
    });
    expect(await phaseRows(id)).toMatchObject([
      { position: 0, item_id: 'build', kind: 'work', state: 'pending', agent_provider: 'codex' },
      {
        position: 1,
        item_id: 'polish',
        kind: 'work',
        state: 'pending',
        agent_provider: 'claude_code',
      },
      { position: 2, item_id: 'finish', kind: 'work', state: 'pending', agent_provider: 'codex' },
    ]);
    const restored = await runs().findById(id);
    expect(restored?.workflow?.toData()).toEqual({ ...WORKFLOW_RECORD, sendBacks: 2 });
    expect(restored?.phases.map((phase) => phase.agent.name)).toEqual([
      'builder',
      'polisher',
      'finisher',
    ]);
  });

  it('moves to the next Phase in the same transaction that stores the result of the one before', async () => {
    const id = await started(await project());

    await runPhase(id, 1, { kind: 'phase', position: 1 });

    expect(await runColumns(id)).toMatchObject({
      state: 'queued',
      provider: 'claude_code',
      current_phase: 1,
      has_session: false,
      phase_pending: true,
      claimed_by: null,
    });
    expect(await phaseRows(id)).toMatchObject([
      { position: 0, state: 'done', session_ref: 'session-1', summary: 'Phase 1 done.', steps: 1 },
      {
        position: 1,
        state: 'pending',
        session_ref: null,
        summary: null,
        steps_before_part: 1,
        steps: 0,
      },
      { position: 2, state: 'pending', steps: 0 },
    ]);
  });

  it('hands the next Phase only to the worker that has the Working copy, and holds the place meanwhile', async () => {
    const projectId = await project();
    const id = await started(projectId);
    await runPhase(id, 1, { kind: 'phase', position: 1 });

    expect(await runs().claimNext(OTHER_WORKER, NOW)).toBeNull();
    const second = await started(projectId);
    expect(await runs().claimNext(WORKER, NOW)).toMatchObject({ id });
    expect((await runs().findById(second))?.lifecycle.state).toBe('queued');
  });

  it('stores the Run step of the second Phase on that Phase, and keeps the one claim at a time', async () => {
    const id = await started(await project());
    await runPhase(id, 1, { kind: 'phase', position: 1 });

    await runPhase(id, 2, { kind: 'phase', position: 2 });

    expect(await phaseRows(id)).toMatchObject([
      { position: 0, state: 'done', steps: 1 },
      { position: 1, state: 'done', session_ref: 'session-2', steps: 1 },
      { position: 2, state: 'pending', steps: 0 },
    ]);
    expect(await runs().claimNext(WORKER, NOW)).toMatchObject({ id });
    expect(await runs().claimNext(WORKER, NOW)).toBeNull();
  });

  it('refuses a second active Run of the project while a Run waits between two Phases', async () => {
    const projectId = await project();
    const id = await started(projectId);
    await runPhase(id, 1, { kind: 'phase', position: 1 });

    const claimedOther = await runs().claimNext(OTHER_WORKER, NOW, null);

    expect(claimedOther).toBeNull();
    expect((await runColumns(id)).phase_pending).toBe(true);
  });

  it('keeps a Run of a Workflow in the database as the Run restores it', async () => {
    const id = await started(await project());
    await runPhase(id, 1, { kind: 'phase', position: 1 });

    const restored = (await runs().findById(id))!;

    expect(restored).toMatchObject({ currentPhase: 1, phasePending: true });
    expect(restored.agent.name).toBe('polisher');
    expect(restored.phases.map((phase) => [phase.state, phase.summary])).toEqual([
      ['done', 'Phase 1 done.'],
      ['pending', null],
      ['pending', null],
    ]);
  });
});
