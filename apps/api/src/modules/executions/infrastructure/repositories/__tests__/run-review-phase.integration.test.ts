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
const WORKING_COPY = { runBranch: 'run/x', commits: [], hasUncommittedChanges: true };
const LIMITS = { stepMinutes: 60, maxSteps: 3, waitingDays: 14, maxTotalSteps: 20 };

describe('a review Phase is stored with its Verdict (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const runs = () => app.get<RunRepository>(RUN_REPOSITORY);

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(services.config);
  });

  beforeEach(async () => {
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  async function reviewRun(sendBacks?: number): Promise<string> {
    const name = `Shop ${randomUUID()}`;
    const [project] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    const builder = phaseAgent('builder');
    const run = await runs().add(
      Run.start({
        id: randomUUID(),
        projectId: project!.id,
        provider: builder.provider,
        agent: builder,
        workflow: {
          record: {
            ...WORKFLOW_RECORD,
            items: [
              { id: 'build', kind: 'work', agent: 'builder' },
              { id: 'check', kind: 'review', agent: 'reviewer' },
            ],
            ...(sendBacks === undefined ? {} : { sendBacks }),
          },
          phaseAgents: [builder, phaseAgent('reviewer', 'claude_code')],
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

  async function report(
    id: string,
    index: number,
    record: object,
    next: Parameters<Run['reportStep']>[5],
  ) {
    const claimed = await runs().claimNext(WORKER, NOW);
    expect(claimed?.id).toBe(id);
    await runs().change(id, (run) => {
      run.reportState(WORKER, { state: 'running', failure: null }, NOW);
      run.reportStep(
        WORKER,
        {
          kind: 'start',
          index,
          result: { outcome: 'done', summary: `Phase ${index} done.`, ...record },
          sessionRef: `session-${index}`,
          ...record,
        },
        WORKING_COPY,
        [],
        NOW,
        next,
      );
    });
  }

  it('records the Phases as work and review, and stores the Verdict and findings of the review', async () => {
    const id = await reviewRun();
    await report(id, 1, {}, { kind: 'phase', position: 1 });
    const findings = [{ text: 'Wrong.', file: 'src/a.ts', line: 3 }, { text: 'Also.' }];

    await report(id, 2, { verdict: 'changes_requested', findings }, { kind: 'end' });

    const rows = await db().$queryRaw<
      { kind: string; verdict: string | null; findings: unknown }[]
    >`SELECT kind, verdict, findings FROM run_phases WHERE run_id = ${id}::uuid ORDER BY position`;
    expect(rows).toEqual([
      { kind: 'work', verdict: null, findings: null },
      { kind: 'review', verdict: 'changes_requested', findings },
    ]);
    const restored = await runs().findById(id);
    expect(restored?.reviewNotPassed).toBe(true);
    expect(restored?.phases[1]).toMatchObject({ verdict: 'changes_requested', findings });
  });

  it('refuses a Verdict on a work Phase and a Verdict without findings at the database', async () => {
    const id = await reviewRun();

    await expect(
      db().$executeRaw`UPDATE run_phases SET verdict = 'approved', findings = '[]'::jsonb
        WHERE run_id = ${id}::uuid AND position = 0`,
    ).rejects.toThrow();
    await expect(
      db().$executeRaw`UPDATE run_phases SET verdict = 'approved'
        WHERE run_id = ${id}::uuid AND position = 1`,
    ).rejects.toThrow();
    await expect(
      db().$executeRaw`UPDATE run_phases SET verdict = 'rejected', findings = '[]'::jsonb
        WHERE run_id = ${id}::uuid AND position = 1`,
    ).rejects.toThrow();
  });

  describe('a send-back', () => {
    const FINDINGS = [{ text: 'Wrong.', file: 'src/a.ts', line: 3 }, { text: 'Also.' }];

    async function sentBack(sendBacks?: number): Promise<string> {
      const id = await reviewRun(sendBacks);
      await report(id, 1, {}, { kind: 'phase', position: 1 });
      await report(
        id,
        2,
        { verdict: 'changes_requested', findings: FINDINGS },
        { kind: 'send_back', position: 0 },
      );
      return id;
    }

    it('stores the count, the review owed a re-run and the limit the Run recorded', async () => {
      const id = await sentBack(1);

      const [row] = await db().$queryRaw<
        {
          workflow_send_backs: number | null;
          send_backs_used: number;
          send_back_review: number | null;
          current_phase: number;
          phase_pending: boolean;
        }[]
      >`SELECT workflow_send_backs, send_backs_used, send_back_review, current_phase, phase_pending
          FROM runs WHERE id = ${id}::uuid`;
      expect(row).toEqual({
        workflow_send_backs: 1,
        send_backs_used: 1,
        send_back_review: 1,
        current_phase: 0,
        phase_pending: true,
      });
      const restored = await runs().findById(id);
      expect(restored).toMatchObject({ sendBacksUsed: 1, sendBackReview: 1, currentPhase: 0 });
      expect(restored?.sendBack).toEqual({ used: 1, limit: 1 });
    });

    it("keeps each Phase's earlier round and starts the next one without a Verdict", async () => {
      const id = await sentBack();

      const rows = await db().$queryRaw<
        {
          position: number;
          summary: string | null;
          verdict: string | null;
          findings: unknown;
          rounds: unknown;
        }[]
      >`SELECT position, summary, verdict, findings, rounds FROM run_phases
          WHERE run_id = ${id}::uuid ORDER BY position`;
      expect(rows[0]).toMatchObject({ summary: null, verdict: null, findings: null });
      expect(rows[1]).toMatchObject({ summary: null, verdict: null, findings: null });
      expect(rows[1]!.rounds).toEqual([
        { round: 1, summary: 'Phase 2 done.', verdict: 'changes_requested', findings: FINDINGS },
      ]);
      const restored = await runs().findById(id);
      expect(restored?.phases[0]?.rounds).toEqual([
        { round: 1, summary: 'Phase 1 done.', verdict: null, findings: [] },
      ]);
      expect(restored?.reviewNotPassed).toBe(false);
    });

    it('goes on to the review and gives its next Verdict as a second round, the count unchanged', async () => {
      const id = await sentBack();
      await report(id, 3, {}, { kind: 'phase', position: 1 });

      await report(id, 4, { verdict: 'approved', findings: [] }, { kind: 'end' });

      const restored = await runs().findById(id);
      expect(restored).toMatchObject({ sendBacksUsed: 1, sendBackReview: null });
      expect(restored?.phases[1]).toMatchObject({ verdict: 'approved' });
      expect(restored?.phases[1]?.rounds.map((round) => round.round)).toEqual([1]);
    });

    it('starts the count again with a Follow-up', async () => {
      const id = await sentBack();
      await report(id, 3, {}, { kind: 'phase', position: 1 });
      await report(id, 4, { verdict: 'approved', findings: [] }, { kind: 'end' });
      await runs().change(id, (run) =>
        run.reportState(
          WORKER,
          { state: 'succeeded', failure: null, delivery: { outcome: 'none' } },
          NOW,
        ),
      );

      await runs().change(id, (run) => {
        run.followUp('Again.', NOW, { workerAvailable: true, providerAvailable: true });
      });

      const [row] = await db().$queryRaw<
        { send_backs_used: number; send_back_review: number | null }[]
      >`
        SELECT send_backs_used, send_back_review FROM runs WHERE id = ${id}::uuid`;
      expect(row).toEqual({ send_backs_used: 0, send_back_review: null });
    });

    it('refuses at the database a count above two and a limit above two', async () => {
      const id = await reviewRun();

      await expect(
        db().$executeRaw`UPDATE runs SET send_backs_used = 3 WHERE id = ${id}::uuid`,
      ).rejects.toThrow();
      await expect(
        db().$executeRaw`UPDATE runs SET workflow_send_backs = 3 WHERE id = ${id}::uuid`,
      ).rejects.toThrow();
      await expect(
        db().$executeRaw`UPDATE runs SET send_backs_used = -1 WHERE id = ${id}::uuid`,
      ).rejects.toThrow();
    });

    it('records no limit above two, whatever a plan says', async () => {
      const id = await reviewRun(9);

      const [row] = await db().$queryRaw<{ workflow_send_backs: number }[]>`
        SELECT workflow_send_backs FROM runs WHERE id = ${id}::uuid`;
      expect(row?.workflow_send_backs).toBe(2);
    });
  });
});
