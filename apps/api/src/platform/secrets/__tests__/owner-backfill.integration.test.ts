import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { deployMigrations } from '@agentic-studio/database/migrations';
import { startPostgres, type TestService } from '@agentic-studio/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig, WITHOUT_QUEUE_WORKERS } from '../../../__tests__/test-config.js';
import { createApp } from '../../../app.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../../database/database.module.js';

// Issue #76: the migration that gives every stored secret an owner label backfills the rows
// that existed before it. The suite applies every committed migration, puts the `secrets`
// table back into its shape before the migration (no owner column), stores rows the way the
// earlier code did, then runs the migration's own SQL file and reads the labels.

const MIGRATION = '20261114300000_secret_owner';
const migrationsDir = join(
  dirname(createRequire(import.meta.url).resolve('@agentic-studio/database/migrations')),
  '..',
  'prisma',
  'migrations',
);

/** The migration's statements, without comment lines (none of its statements contains `;`). */
async function migrationStatements(): Promise<string[]> {
  const sql = await readFile(join(migrationsDir, MIGRATION, 'migration.sql'), 'utf8');
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

describe('secret owner migration (PostgreSQL via Testcontainers)', () => {
  let postgres: TestService;
  let app: INestApplication;
  let db: DatabaseClient;

  beforeAll(async () => {
    postgres = await startPostgres();
    await deployMigrations(postgres.url);
    app = await createApp(testConfig({ databaseUrl: postgres.url }), WITHOUT_QUEUE_WORKERS);
    await app.init();
    db = app.get<DatabaseClient>(DATABASE_CLIENT);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
  });

  it('labels the secrets Repositories reference as Deploy keys and no other row', async () => {
    // Back to the table before the migration (dropping the column drops its index and CHECK).
    await db.$executeRaw`ALTER TABLE secrets DROP COLUMN owner`;
    const insertSecret = async (): Promise<string> => {
      const [row] = await db.$queryRaw<{ id: string }[]>`
        INSERT INTO secrets (id, ciphertext, nonce, auth_tag, key_version)
        VALUES (gen_random_uuid(), '\\x00'::bytea, decode(repeat('00', 12), 'hex'),
                decode(repeat('00', 16), 'hex'), 1)
        RETURNING id::text AS id`;
      return row!.id;
    };
    const referenced = await insertSecret();
    const unreferenced = await insertSecret();
    const [project] = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES ('Shop', 'shop') RETURNING id::text AS id`;
    await db.$executeRaw`
      INSERT INTO repositories (project_id, url, url_normalized, integration_branch, state,
                                deploy_key_secret_id, public_key)
      VALUES (${project!.id}::uuid, 'git@github.com:acme/shop.git', 'github.com/acme/shop', 'dev',
              'awaiting_key', ${referenced}::uuid, 'placeholder public key')`;

    for (const statement of await migrationStatements()) await db.$executeRawUnsafe(statement);

    const owners = await db.$queryRaw<{ id: string; owner: string }[]>`
      SELECT id::text AS id, owner FROM secrets ORDER BY owner`;
    expect(owners).toEqual([
      { id: referenced, owner: 'projects.deploy-key' },
      // Nobody can tell what an unreferenced row was for: it gets a label no module sweeps.
      { id: unreferenced, owner: 'unowned' },
    ]);
    await expect(
      db.$executeRaw`UPDATE secrets SET owner = NULL WHERE id = ${referenced}::uuid`,
    ).rejects.toThrow(/null/i);
  });
});
