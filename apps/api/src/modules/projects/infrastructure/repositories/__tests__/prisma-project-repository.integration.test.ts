import { randomUUID } from 'node:crypto';
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

// Issue #76, PR #77 review S-1: a Retry that keeps the failed Repository's Deploy key
// (`keepsDeployKey`) is saved only while that Repository still references the key. Against
// real PostgreSQL: when the key changed or the Repository is gone, it is refused with 409
// (RepositoryAlreadyConnectedError) and nothing is written. Key references are throwaway ids;
// no secret is stored.

const SSH_URL = 'git@github.com:acme/shop.git';
const SSH_IDENTITY = 'github.com/acme/shop';

describe('PrismaProjectRepository: a Retry that keeps its Deploy key (PostgreSQL)', () => {
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
