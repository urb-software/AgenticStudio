import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { deployMigrations } from '@agentic-studio/database/migrations';
import { startPostgres, type TestService } from '@agentic-studio/testing';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testConfig, WITHOUT_QUEUE_WORKERS } from '../../../../../__tests__/test-config.js';
import { createApp } from '../../../../../app.js';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../../platform/database/database.module.js';
import { repositoryFailure } from '../../../domain/entities/repository.js';
import { RepositoryAlreadyConnectedError } from '../../../domain/repositories/project-repository.js';
import { ProjectName } from '../../../domain/value-objects/project-name.js';
import { PrismaProjectRepository } from '../prisma-project-repository.js';

// Against real PostgreSQL.
//
// Issue #76, PR #77 review S-1: a Retry that keeps the failed Repository's Deploy key
// (`keepsDeployKey`) is saved only while that Repository still references the key. Against
// real PostgreSQL: when the key changed or the Repository is gone, it is refused with 409
// (RepositoryAlreadyConnectedError) and nothing is written. Key references are throwaway ids;
// no secret is stored.

// Issue #72: the migration that adds the `interrupted` failure code moves the failures the
// earlier code stored as `unknown` / 'Interrupted' to it.

const SSH_URL = 'git@github.com:acme/shop.git';

const migrationsDir = join(
  dirname(createRequire(import.meta.url).resolve('@agentic-studio/database/migrations')),
  '..',
  'prisma',
  'migrations',
);

/** A migration's statements, without comment lines (none of its statements contains `;`). */
async function migrationStatements(migration: string): Promise<string[]> {
  const sql = await readFile(join(migrationsDir, migration, 'migration.sql'), 'utf8');
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}
const SSH_IDENTITY = 'github.com/acme/shop';

describe('PrismaProjectRepository (PostgreSQL)', () => {
  let postgres: TestService;
  let app: INestApplication;
  let db: DatabaseClient;
  let projects: PrismaProjectRepository;
  let projectId: string;

  /** A failed SSH Repository holding `secretRef` (its host was unreachable). */
  async function failedSsh(secretRef: string) {
    await projects.beginConnect({
      projectId,
      url: SSH_URL,
      identity: SSH_IDENTITY,
      integrationBranch: 'dev',
      deployKey: { publicKey: 'placeholder public key', secretRef },
    });
    expect(await projects.failVerification(projectId, repositoryFailure('host_unreachable'))).toBe(
      true,
    );
  }

  /** The Retry over SSH that keeps `secretRef`, as Connect sends it. */
  const retryKeeping = (secretRef: string) =>
    projects.beginConnect({
      projectId,
      url: SSH_URL,
      identity: SSH_IDENTITY,
      integrationBranch: 'main',
      deployKey: { publicKey: 'placeholder public key', secretRef },
      keepsDeployKey: true,
    });

  beforeAll(async () => {
    postgres = await startPostgres();
    await deployMigrations(postgres.url);
    app = await createApp(testConfig({ databaseUrl: postgres.url }), WITHOUT_QUEUE_WORKERS);
    await app.init();
    db = app.get<DatabaseClient>(DATABASE_CLIENT);
    projects = new PrismaProjectRepository(db);
  });

  afterAll(async () => {
    await app?.close();
    await postgres?.stop();
  });

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE projects CASCADE`;
    projectId = (await projects.add(ProjectName.parse('Shop'))).id;
  });

  describe('a Retry that keeps its Deploy key', () => {
    it('replaces the failed Repository while it still references the kept key', async () => {
      const key = randomUUID();
      await failedSsh(key);

      const retried = await retryKeeping(key);

      expect(retried).toMatchObject({
        state: 'awaiting_key',
        integrationBranch: 'main',
        deployKeySecret: key,
        failure: null,
      });
    });

    it('refuses with 409 and writes nothing when the Repository references another key', async () => {
      const key = randomUUID();
      await failedSsh(key);
      // Meanwhile another connect replaced it over HTTPS (releasing the key), and that failed.
      await projects.beginConnect({
        projectId,
        url: 'https://github.com/acme/shop.git',
        identity: SSH_IDENTITY,
        integrationBranch: 'dev',
      });
      await projects.markFailed(projectId, repositoryFailure('unknown'));
      const before = await projects.findRepository(projectId);

      await expect(retryKeeping(key)).rejects.toBeInstanceOf(RepositoryAlreadyConnectedError);

      expect(await projects.findRepository(projectId)).toEqual(before);
      expect(before).toMatchObject({ state: 'failed', deployKeySecret: null });
    });

    it('refuses with 409 and creates nothing when the Repository is gone', async () => {
      const key = randomUUID();
      await failedSsh(key);
      // Meanwhile a disconnect removed it (and deleted its key).
      await projects.beginDisconnect(projectId);
      expect(await projects.deleteDisconnecting(projectId)).toBe(true);

      await expect(retryKeeping(key)).rejects.toBeInstanceOf(RepositoryAlreadyConnectedError);

      expect(await projects.findRepository(projectId)).toBeNull();
      expect(await projects.listDeployKeySecretRefs()).toEqual([]);
    });
  });

  describe('the interrupted migration (#72)', () => {
    it('moves the failures stored as unknown / "Interrupted" to interrupted, and only those', async () => {
      const other = (await projects.add(ProjectName.parse('Other'))).id;
      // Test setup only: failures as the earlier code stored them.
      await db.$executeRaw`
        INSERT INTO repositories (project_id, url, url_normalized, integration_branch, state, failure_code, failure_detail)
        VALUES (${projectId}::uuid, 'https://github.com/acme/shop.git', 'github.com/acme/shop', 'dev', 'failed', 'unknown', 'Interrupted'),
               (${other}::uuid, 'https://github.com/acme/other.git', 'github.com/acme/other', 'dev', 'failed', 'unknown', 'Interrupted by the host')`;

      for (const statement of await migrationStatements('20261114500000_repository_interrupted')) {
        await db.$executeRawUnsafe(statement);
      }

      expect((await projects.findRepository(projectId))?.failure).toEqual({
        code: 'interrupted',
        detail: '',
        remoteDefaultBranch: null,
      });
      expect((await projects.findRepository(other))?.failure).toEqual({
        code: 'unknown',
        detail: 'Interrupted by the host',
        remoteDefaultBranch: null,
      });
    });
  });
});
