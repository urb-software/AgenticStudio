import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunFailure } from '../../../domain/value-objects/run-failure.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../../platform/database/database.module.js';
import {
  startStudioApp,
  startStudioServices,
  type StudioServices,
} from '../../../../../__tests__/studio-test-app.js';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const WORKER = randomUUID();
const WORKING_COPY = { runBranch: 'run/x', commits: [], hasUncommittedChanges: false };

describe('the session of a Run is kept on its Phase (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const runs = () => app.get<RunRepository>(RUN_REPOSITORY);

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(services.config);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  async function runningRun(): Promise<string> {
    const name = `Shop ${randomUUID()}`;
    const [project] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    const created = await db().run.create({
      data: {
        projectId: project!.id,
        provider: 'codex',
        phases: {
          create: {
            position: 0,
            agentName: 'default-codex',
            agentSource: 'built_in',
            agentProvider: 'codex',
            agentModel: 'default',
            agentInstructions: '',
          },
        },
        task: 'Add a health check',
        startCommit: 'a'.repeat(40),
        remoteUrl: 'https://git.example.test/acme/shop.git',
        integrationBranch: 'dev',
        limitStepMinutes: 60,
        limitMaxSteps: 5,
        limitWaitingDays: 14,
        state: 'running',
        claimedBy: WORKER,
        lastClaimedBy: WORKER,
        heartbeatAt: NOW,
        startedAt: NOW,
        stepStartedAt: NOW,
      },
      select: { id: true },
    });
    return created.id;
  }

  async function sessionColumns(runId: string) {
    const [row] = await db().$queryRaw<{ has_session: boolean; session_ref: string | null }[]>`
      SELECT r.has_session, p.session_ref FROM runs r
      JOIN run_phases p ON p.run_id = r.id AND p.position = r.current_phase
      WHERE r.id = ${runId}::uuid`;
    return row;
  }

  it('sets has_session with the session of a Run step that asks a question', async () => {
    const id = await runningRun();

    await runs().change(id, (run) => {
      run.reportStep(
        WORKER,
        {
          kind: 'start',
          result: { outcome: 'needs_input' },
          question: { text: 'Which database?' },
          sessionRef: 'session-1',
        },
        WORKING_COPY,
        [],
        NOW,
      );
    });

    expect(await sessionColumns(id)).toEqual({ has_session: true, session_ref: 'session-1' });
    const [step] = await db().$queryRaw<{ in_phase: boolean }[]>`
      SELECT (s.phase_id = p.id) AS in_phase FROM run_steps s
      JOIN run_phases p ON p.run_id = s.run_id AND p.position = 0
      WHERE s.run_id = ${id}::uuid`;
    expect(step).toEqual({ in_phase: true });
  });

  it('sets has_session with the session reported at a usage-limit failure', async () => {
    const id = await runningRun();

    await runs().change(id, (run) => {
      run.reportState(
        WORKER,
        {
          state: 'failed',
          failure: RunFailure.of('usage_limit', 'The usage limit was reached.'),
          sessionRef: 'session-2',
        },
        NOW,
      );
    });

    expect(await sessionColumns(id)).toEqual({ has_session: true, session_ref: 'session-2' });
  });

  it('leaves has_session false when no session was reported', async () => {
    const id = await runningRun();

    await runs().change(id, (run) => {
      run.reportStep(WORKER, { kind: 'start', result: {} }, WORKING_COPY, [], NOW);
    });

    expect(await sessionColumns(id)).toEqual({ has_session: false, session_ref: null });
  });
});
