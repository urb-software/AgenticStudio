import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUN_LOG, type RunLog } from '../../../application/ports/run-log.js';
import { LogAppendRule } from '../../../domain/value-objects/log-append-rule.js';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../../platform/database/database.module.js';
import {
  startStudioApp,
  startStudioServices,
  type StudioServices,
} from '../../../../../__tests__/studio-test-app.js';

const T = new Date('2026-11-17T09:00:00.000Z');
const W1 = randomUUID();
const W2 = randomUUID();

describe('the log store follows the rule of the domain (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const log = () => app.get<RunLog>(RUN_LOG);

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(services.config);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  const ROWS = {
    queued: { state: 'queued' },
    preparing: { state: 'preparing', claimedBy: W1, heartbeatAt: T, startedAt: T },
    running: {
      state: 'running',
      claimedBy: W1,
      heartbeatAt: T,
      startedAt: T,
      stepStartedAt: T,
    },
    waiting: { state: 'waiting_for_operator', waitingSince: T, startedAt: T },
    succeeded: { state: 'succeeded', finishedAt: T, startedAt: T },
    // Held by a worker for a delivery retry, yet not a state a log is appended in.
    failedHeldForRetry: {
      state: 'failed',
      failureCode: 'delivery_failed',
      failureDetail: 'x',
      delivery: 'failed',
      deliveryRequested: true,
      claimedBy: W1,
      heartbeatAt: T,
      startedAt: T,
      finishedAt: T,
    },
  } as const;

  for (const [name, row] of Object.entries(ROWS)) {
    for (const worker of [W1, W2]) {
      it(`appends exactly when the rule allows: ${name}, worker ${worker === W1 ? 1 : 2}`, async () => {
        const projectName = `Shop ${randomUUID()}`;
        const [project] = await db().$queryRaw<{ id: string }[]>`
          INSERT INTO projects (name, name_normalized)
          VALUES (${projectName}, ${projectName.toLowerCase()}) RETURNING id`;
        const created = await db().run.create({
          data: {
            projectId: project!.id,
            provider: 'codex',
            agentName: 'default-codex',
            agentSource: 'built_in',
            agentProvider: 'codex',
            agentModel: 'default',
            agentInstructions: '',
            task: 'Add a health check',
            startCommit: 'a'.repeat(40),
            remoteUrl: 'https://git.example.test/acme/shop.git',
            integrationBranch: 'dev',
            limitStepMinutes: 60,
            limitMaxSteps: 5,
            limitWaitingDays: 14,
            ...row,
          },
        });
        const event = { seq: 1, at: T, stepIndex: 1, kind: 'notice', text: 'x', truncated: false };

        const stored = await log().append(created.id, worker, [event] as never, 1_000_000);

        const expected = LogAppendRule.for(worker).allows({
          state: created.state as never,
          claimedBy: created.claimedBy,
        });
        expect(stored !== null).toBe(expected);
        expect(await db().runEvent.count({ where: { runId: created.id } })).toBe(expected ? 1 : 0);
      });
    }
  }
});
