import { committedMigrations, deployMigrations } from '@agentic-studio/database/migrations';
import { startPostgres, type TestService } from '@agentic-studio/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../../../__tests__/test-config.js';
import { createApp } from '../../../app.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../database.module.js';

describe('database DI against a fresh PostgreSQL', () => {
  let postgres: TestService;
  let app: INestApplication;

  beforeAll(async () => {
    postgres = await startPostgres();
    await deployMigrations(postgres.url);
    app = await createApp(testConfig({ databaseUrl: postgres.url }));
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

  it('round-trips a query through the DI-provided client', async () => {
    const client = app.get<DatabaseClient>(DATABASE_CLIENT);

    const [row] = await client.$queryRaw<{ answer: number }[]>`SELECT 41 + 1 AS answer`;

    expect(row).toEqual({ answer: 42 });
  });
});
