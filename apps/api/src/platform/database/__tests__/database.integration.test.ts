import {
  committedMigrations,
  deployMigrations,
  schemaDriftScript,
} from '@agentic-studio/database/migrations';
import { startPostgres, type TestService } from '@agentic-studio/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig, WITHOUT_QUEUE_WORKERS } from '../../../__tests__/test-config.js';
import { createApp } from '../../../app.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../database.module.js';

describe('database DI against a fresh PostgreSQL', () => {
  let postgres: TestService;
  let app: INestApplication;

  beforeAll(async () => {
    postgres = await startPostgres();
    await deployMigrations(postgres.url);
    app = await createApp(testConfig({ databaseUrl: postgres.url }), WITHOUT_QUEUE_WORKERS);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
  });

  it('records every committed migration as applied', async () => {
    const client = app.get<DatabaseClient>(DATABASE_CLIENT);

    const applied = await client.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name`;

    // Every committed migration, not a fixed list: a new migration needs no test edit.
    const committed = await committedMigrations();
    expect(committed[0]).toBe('20261112000000_baseline');
    expect(applied.map((row) => row.migration_name)).toEqual(committed);
  });

  it('keeps the partial unique index behind the one-active-Run-per-project limit', async () => {
    const client = app.get<DatabaseClient>(DATABASE_CLIENT);

    const [index] = await client.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'runs_one_active_per_project_key'`;

    expect(index?.indexdef).toMatch(
      /^CREATE UNIQUE INDEX .* ON public\.runs .*\(project_id\) WHERE/,
    );
    expect(index?.indexdef).toMatch(/preparing.*running.*waiting_for_operator/);
    // An answered Run waiting in the queue for its worker keeps the place.
    expect(index?.indexdef).toMatch(/queued.*has_session/);
  });

  it('records what `prisma migrate dev` would propose for objects Prisma does not model', async () => {
    const script = await schemaDriftScript(postgres.url);
    const statements = script
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) => line !== '' && !line.startsWith('--') && !line.startsWith('Loaded Prisma config'),
      );
    // Printed in the CI log, so a drift is visible without rerunning.
    console.info(`prisma migrate diff (database -> schema):\n${script.trim() || '(empty)'}`);

    // Observed on CI: Prisma proposes neither dropping the partial index nor any CHECK constraint.
    // Its only drift is re-asserting every `dbgenerated("now()")` column default (`SET DEFAULT
    // now()`), a no-op present since the baseline, which is left out here.
    const noOpDefault = /^(ALTER TABLE "\w+" )?ALTER COLUMN "\w+" SET DEFAULT now\(\)[,;]$/;
    expect(statements.filter((line) => !noOpDefault.test(line))).toEqual([]);
    expect(script).not.toContain('runs_one_active_per_project_key');
    expect(script).not.toMatch(/DROP|CONSTRAINT/);
  });

  it('round-trips a query through the DI-provided client', async () => {
    const client = app.get<DatabaseClient>(DATABASE_CLIENT);

    const [row] = await client.$queryRaw<{ answer: number }[]>`SELECT 41 + 1 AS answer`;

    expect(row).toEqual({ answer: 42 });
  });
});
