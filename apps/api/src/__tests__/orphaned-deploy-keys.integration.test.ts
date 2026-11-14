import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import type { INestApplication, LoggerService } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { AppModule } from '../app.module.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import {
  SECRET_STORE,
  SecretNotFoundError,
  type SecretStore,
  SecretStoreUnavailableError,
} from '../platform/secrets/index.js';
import { createGitFixture, type GitFixture } from './git-fixture.js';
import {
  signIn,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// Issue #76: Deploy keys no Repository references are deleted by a sweep at start-up (after
// the repository queue is reconciled, before its worker starts) and after a Connect fails to
// delete a replaced key. The real app with PostgreSQL and Redis (Testcontainers) and the real
// job queue. The two orphan cases of the Issue: a crash between storing a key and saving the
// Repository (simulated: the key is stored under the Deploy-key label and nothing references
// it), on every platform; a failed delete when a failed SSH Repository is replaced over HTTPS,
// on Linux only, because a Connect needs the Git adapter (CI runs it; the guard at the end fails
// CI if it was skipped). Every value is generated at run time.

const linux = process.platform === 'linux';
/** The owner label `projects` stores Deploy keys under. */
const DEPLOY_KEY_OWNER = { owner: 'projects.deploy-key' } as const;
/** Another module's label. */
const OTHER_OWNER = { owner: 'tests.other-module' } as const;
/** A throwaway stand-in for a private key: only its absence from logs is asserted. */
const throwawayValue = (name: string) =>
  `-----BEGIN TEST VALUE-----\n${name}-test-only-${randomUUID()}\n-----END TEST VALUE-----\n`;

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('orphaned Deploy-key sweep (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let dataDir: string;
  let app: INestApplication | undefined;
  let cookie: string;
  const logs: string[] = [];

  const capture =
    (level: string) =>
    (message: unknown, ...rest: unknown[]) => {
      logs.push(`${level} ${format(message, ...rest)}`);
    };
  const logger: LoggerService = {
    log: capture('log'),
    error: capture('error'),
    warn: capture('warn'),
    debug: capture('debug'),
    verbose: capture('verbose'),
    fatal: capture('fatal'),
  };

  const db = () => app!.get<DatabaseClient>(DATABASE_CLIENT);
  const secretStore = () => app!.get<SecretStore>(SECRET_STORE);
  const deletedLines = () => logs.filter((line) => line.includes('Deleted the orphaned'));
  /** The sweep's log line for one deleted secret: its id only (Nest appends the context). */
  const deletedLine = (reference: string) =>
    `log Deleted the orphaned Deploy key secret ${reference}. DeployKeySweep`;

  /** (Re)starts the app, which runs the start-up sweep; `gracePeriodMs` defaults to 1 hour. */
  async function start(gracePeriodMs?: number) {
    await app?.close();
    app = await buildApp(
      AppModule.register(services.config, {
        projects: gracePeriodMs === undefined ? {} : { deployKeySweep: { gracePeriodMs } },
      }),
      { logger },
    );
    await app.init();
    cookie = await signIn(app);
  }

  async function createProject(name: string): Promise<string> {
    const response = await request(app!.getHttpServer())
      .post('/api/projects')
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send({ name });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  async function exists(reference: string): Promise<boolean> {
    try {
      await secretStore().get(reference);
      return true;
    } catch (error) {
      if (error instanceof SecretNotFoundError) return false;
      throw error;
    }
  }

  beforeAll(async () => {
    services = await startStudioServices();
    dataDir = await mkdtemp(join(tmpdir(), 'studio-orphaned-keys-'));
    services.config = { ...services.config, dataDir, gitAllowFileRemotes: true };
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await start();
    // Test isolation only; assertions use the API and the secret store's port.
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    for (const owner of [DEPLOY_KEY_OWNER.owner, OTHER_OWNER.owner]) {
      for (const reference of await secretStore().listOlderThan(owner, 0)) {
        await secretStore().delete(reference);
      }
    }
    logs.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('at start-up deletes the key of a crashed connect once past the grace period, and nothing else', async () => {
    const crashedValue = throwawayValue('crashed');
    // A connect stored its Deploy key, then the process stopped before saving the Repository.
    const crashed = await secretStore().put(crashedValue, DEPLOY_KEY_OWNER);
    // A Repository referencing its Deploy key (test setup: stored directly).
    const referenced = await secretStore().put(throwawayValue('referenced'), DEPLOY_KEY_OWNER);
    const projectId = await createProject('Referenced');
    await db().$executeRaw`
      INSERT INTO repositories (project_id, url, url_normalized, integration_branch, state,
                                deploy_key_secret_id, public_key)
      VALUES (${projectId}::uuid, 'git@github.com:acme/shop.git', 'github.com/acme/shop', 'dev',
              'awaiting_key', ${referenced}::uuid, 'placeholder public key')`;
    // A disconnecting Repository still holds its key until its cleanup deletes it.
    const disconnecting = await secretStore().put(
      throwawayValue('disconnecting'),
      DEPLOY_KEY_OWNER,
    );
    const otherProjectId = await createProject('Disconnecting');
    await db().$executeRaw`
      INSERT INTO repositories (project_id, url, url_normalized, integration_branch, state,
                                deploy_key_secret_id, public_key)
      VALUES (${otherProjectId}::uuid, 'git@github.com:acme/old.git', 'github.com/acme/old', 'dev',
              'disconnecting', ${disconnecting}::uuid, 'placeholder public key')`;
    // Another module's secret, which nothing in `projects` references.
    const otherOwners = await secretStore().put(throwawayValue('other'), OTHER_OWNER);

    // Inside the grace period: a fresh orphan is kept.
    await start();
    expect(await exists(crashed)).toBe(true);
    expect(deletedLines()).toEqual([]);

    // Past it (test setup: a grace period of zero instead of waiting an hour).
    await start(0);
    expect(await exists(crashed)).toBe(false);
    expect(await exists(referenced)).toBe(true);
    expect(await exists(disconnecting)).toBe(true);
    expect(await exists(otherOwners)).toBe(true);
    expect(deletedLines()).toEqual([deletedLine(crashed)]);
    expect(logs.join('\n')).not.toContain(crashedValue.split('\n')[1]!);

    // The Repository's own key survives every later sweep too.
    await start(0);
    expect(await exists(referenced)).toBe(true);
  });

  describe.runIf(linux)(
    'a failed delete when a failed SSH Repository is replaced over HTTPS',
    () => {
      let fixtures: string;
      let fixture: GitFixture;

      beforeAll(async () => {
        fixtures = await mkdtemp(join(tmpdir(), 'studio-orphaned-keys-fixtures-'));
        fixture = createGitFixture(fixtures, 'shop');
      });

      afterAll(async () => {
        if (fixtures) await rm(fixtures, { recursive: true, force: true });
      });

      const connect = (projectId: string, url: string) =>
        request(app!.getHttpServer())
          .post(`/api/projects/${projectId}/repository`)
          .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
          .send({ url, integrationBranch: 'main' });

      async function deployKeyRef(projectId: string): Promise<string> {
        const [row] = await db().$queryRaw<{ ref: string }[]>`
        SELECT deploy_key_secret_id::text AS ref FROM repositories WHERE project_id = ${projectId}::uuid`;
        return row!.ref;
      }

      async function settled(projectId: string) {
        const deadline = Date.now() + 30_000;
        for (;;) {
          const response = await request(app!.getHttpServer())
            .get(`/api/projects/${projectId}/repository`)
            .set('Cookie', cookie);
          if (!['connecting', 'fetching'].includes(response.body.state)) return response.body;
          if (Date.now() > deadline)
            throw new Error(`the repository stayed ${response.body.state}`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      /** An SSH Repository that failed (its host is unreachable); returns its Deploy key's reference. */
      async function failedSshRepository(projectId: string): Promise<string> {
        const url = `ssh://git@127.0.0.1:${await closedPort()}/srv/git/repo.git`;
        expect((await connect(projectId, url)).status).toBe(201);
        const verified = await request(app!.getHttpServer())
          .post(`/api/projects/${projectId}/repository/verify`)
          .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
          .send({});
        expect(verified.body).toMatchObject({
          state: 'failed',
          failure: { code: 'host_unreachable' },
        });
        return deployKeyRef(projectId);
      }

      /** Replaces the failed Repository over HTTPS while the secret store fails one delete. */
      async function replaceOverHttpsWithFailingDelete(projectId: string) {
        vi.spyOn(secretStore(), 'delete').mockRejectedValueOnce(new SecretStoreUnavailableError());
        const replaced = await connect(projectId, fixture.url);
        expect(replaced.status).toBe(201);
        expect(replaced.body).not.toHaveProperty('publicKey');
        expect(logs.join('\n')).toMatch(/could not delete an unused Deploy key/);
        expect(await settled(projectId)).toMatchObject({ state: 'ready' });
      }

      it("never deletes a failed SSH Repository's key; a Retry over SSH keeps it", async () => {
        const projectId = await createProject('Failed kept');
        const key = await failedSshRepository(projectId);

        await start(0);
        expect(await exists(key)).toBe(true);
        expect(deletedLines()).toEqual([]);

        const retried = await connect(
          projectId,
          `ssh://git@127.0.0.1:${await closedPort()}/srv/git/repo.git`,
        );
        expect(retried.status).toBe(201);
        expect(retried.body.state).toBe('awaiting_key');
        expect(await deployKeyRef(projectId)).toBe(key);
      });

      it('keeps the orphan inside the grace period; the start-up sweep deletes it once past it', async () => {
        const projectId = await createProject('Replaced later');
        const orphan = await failedSshRepository(projectId);

        await replaceOverHttpsWithFailingDelete(projectId);
        expect(await exists(orphan)).toBe(true);

        await start(0);
        expect(await exists(orphan)).toBe(false);
        expect(deletedLines()).toEqual([deletedLine(orphan)]);
      });

      it('retries the delete in the sweep that follows the failure, once past the grace period', async () => {
        await start(0);
        const projectId = await createProject('Replaced now');
        const orphan = await failedSshRepository(projectId);

        await replaceOverHttpsWithFailingDelete(projectId);

        expect(await exists(orphan)).toBe(false);
        expect(deletedLines()).toEqual([deletedLine(orphan)]);
      });
    },
  );
});

// Guard against a silent skip: in CI the Linux-only cases must run.
it.runIf(process.env.GITHUB_ACTIONS === 'true')(
  'runs the orphaned Deploy-key replacement cases in CI (Linux)',
  () => {
    expect(process.platform).toBe('linux');
  },
);
