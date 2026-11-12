import { deployMigrations } from '@agentic-studio/database/migrations';
import { startPostgres, type TestService } from '@agentic-studio/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../database.module.js';

describe('database DI against a fresh PostgreSQL', () => {
  let postgres: TestService;
  let app: INestApplication;

  beforeAll(async () => {
    postgres = await startPostgres();
    await deployMigrations(postgres.url);
    app = await createApp({
      apiPort: 0,
      apiOrigin: 'http://localhost:3001',
      databaseUrl: postgres.url,
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
  });

  it('records the committed baseline migration as applied', async () => {
    const client = app.get<DatabaseClient>(DATABASE_CLIENT);

    const applied = await client.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name`;

    expect(applied.map((row) => row.migration_name)).toEqual(['20261112000000_baseline']);
  });

  it('round-trips a query through the DI-provided client', async () => {
    const client = app.get<DatabaseClient>(DATABASE_CLIENT);

    const [row] = await client.$queryRaw<{ answer: number }[]>`SELECT 41 + 1 AS answer`;

    expect(row).toEqual({ answer: 42 });
  });
});
