import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deployMigrations } from '@agentic-studio/database/migrations';
import { startPostgres, startRedis, type TestService } from '@agentic-studio/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig, WITHOUT_QUEUE_WORKERS } from '../../../__tests__/test-config.js';
import { createApp } from '../../../app.js';
import type { AppConfig } from '../../config/config.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../../database/database.module.js';

// Issue #76: the migration that gives every stored secret an owner label backfills the rows
// that existed before it. The suite applies every committed migration, puts the `secrets`
// table back into its shape before the migration (no owner column), stores rows the way the
// earlier code did, then runs the migration's own SQL file. Every existing row becomes a
// Deploy key (the only secret Studio ever stored, operator decision on #76), so the app's
// start-up sweep, with its production settings, then deletes the unreferenced ones once they
// are past the one-hour grace period.

const MIGRATION = '20261114300000_secret_owner';
const MINUTE_MS = 60 * 1000;
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

describe('secret owner migration (PostgreSQL + Redis via Testcontainers)', () => {
  let postgres: TestService;
  let redis: TestService;
  let dataDir: string;
  let config: AppConfig;
  let app: INestApplication | undefined;
  const db = () => app!.get<DatabaseClient>(DATABASE_CLIENT);

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    await deployMigrations(postgres.url);
    dataDir = await mkdtemp(join(tmpdir(), 'studio-owner-backfill-'));
    config = testConfig({ databaseUrl: postgres.url, redisUrl: redis.url, dataDir });
    app = await createApp(config, WITHOUT_QUEUE_WORKERS);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('labels every existing secret a Deploy key; the production sweep deletes the unreferenced ones past one hour', async () => {
    // Back to the table before the migration (dropping the column drops its index and CHECK).
    await db().$executeRaw`ALTER TABLE secrets DROP COLUMN owner`;
    /** A row as the earlier code stored it, `ageMs` old. */
    const insertSecret = async (ageMs: number): Promise<string> => {
      const [row] = await db().$queryRaw<{ id: string }[]>`
        INSERT INTO secrets (id, ciphertext, nonce, auth_tag, key_version, created_at)
        VALUES (gen_random_uuid(), '\\x00'::bytea, decode(repeat('00', 12), 'hex'),
                decode(repeat('00', 16), 'hex'), 1, now() - ${ageMs} * interval '1 millisecond')
        RETURNING id::text AS id`;
      return row!.id;
    };
    const referenced = await insertSecret(120 * MINUTE_MS);
    const orphanPastGrace = await insertSecret(61 * MINUTE_MS);
    const orphanInsideGrace = await insertSecret(59 * MINUTE_MS);
    const [project] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES ('Shop', 'shop') RETURNING id::text AS id`;
    await db().$executeRaw`
      INSERT INTO repositories (project_id, url, url_normalized, integration_branch, state,
                                deploy_key_secret_id, public_key)
      VALUES (${project!.id}::uuid, 'git@github.com:acme/shop.git', 'github.com/acme/shop', 'dev',
              'awaiting_key', ${referenced}::uuid, 'placeholder public key')`;

    for (const statement of await migrationStatements()) await db().$executeRawUnsafe(statement);

    const owners = await db().$queryRaw<{ owner: string; count: number }[]>`
      SELECT owner, count(*)::int AS count FROM secrets GROUP BY owner`;
    expect(owners).toEqual([{ owner: 'projects.deploy-key', count: 3 }]);
    await expect(
      db().$executeRaw`UPDATE secrets SET owner = NULL WHERE id = ${referenced}::uuid`,
    ).rejects.toThrow(/null/i);

    // Restart with the production settings: the start-up sweep runs with its 1-hour default.
    await app!.close();
    app = await createApp(config);
    await app.init();

    const left = await db().$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM secrets`;
    expect(left.map((row) => row.id).sort()).toEqual([referenced, orphanInsideGrace].sort());
    expect(left.map((row) => row.id)).not.toContain(orphanPastGrace);
  });

  it('admits the reserved `unowned` label, kept for future use', async () => {
    const [row] = await db().$queryRaw<{ owner: string }[]>`
      INSERT INTO secrets (id, ciphertext, nonce, auth_tag, key_version, owner)
      VALUES (gen_random_uuid(), '\\x00'::bytea, decode(repeat('00', 12), 'hex'),
              decode(repeat('00', 16), 'hex'), 1, 'unowned')
      RETURNING owner`;

    expect(row).toEqual({ owner: 'unowned' });
  });
});
