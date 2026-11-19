import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { createGitFixture, type GitFixture } from './git-fixture.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';
import { createTestDataDir } from './test-config.js';

// Concurrency evidence for the Repository connection: each case loops ITERATIONS times with real
// concurrency and checks only the outcome that may never differ (real Git, so Linux only).

const linux = process.platform === 'linux';
const ITERATIONS = 25;
const CASE_TIMEOUT = 300_000;
const PROBLEM = 'urn:agentic-studio:problem:';
const HOST_KEY = `ssh-ed25519 ${Buffer.from('studio-race-test-host-key').toString('base64')}`;

/** SHA256 fingerprint of a host key (`<type> <base64>`), as `ssh-keygen -l` prints it. */
function hostKeyFingerprint(hostKey: string): string {
  const data = hostKey.split(' ')[1]!;
  const digest = createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.runIf(linux)(
  'repository connection: simultaneous changes (PostgreSQL + Redis via Testcontainers)',
  () => {
    let services: StudioServices;
    let dataDir: string;
    let fixtures: string;
    let fixture: GitFixture;
    let app: INestApplication;
    let cookie: string;

    const http = () => request(app.getHttpServer());
    const operator = () => ({ Origin: STUDIO_ORIGIN, Cookie: cookie });
    const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);

    const connect = (projectId: string, url = fixture.url) =>
      http()
        .post(`/api/projects/${projectId}/repository`)
        .set(operator())
        .send({ url, integrationBranch: 'dev' });
    const getRepository = (projectId: string) =>
      http().get(`/api/projects/${projectId}/repository`).set('Cookie', cookie);
    const fetchRepository = (projectId: string) =>
      http().post(`/api/projects/${projectId}/repository/fetch`).set(operator());
    const disconnect = (projectId: string) =>
      http().delete(`/api/projects/${projectId}/repository`).set(operator());
    const verify = (projectId: string, body: object = {}) =>
      http().post(`/api/projects/${projectId}/repository/verify`).set(operator()).send(body);

    const statuses = (...responses: request.Response[]) =>
      responses.map((response) => response.status).sort((a, b) => a - b);

    /** Test isolation for one iteration: nothing of an earlier one is left. */
    async function freshIteration() {
      await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    }

    async function createProject(name: string): Promise<string> {
      const response = await http().post('/api/projects').set(operator()).send({ name });
      expect(response.status).toBe(201);
      return response.body.id as string;
    }

    /** Polls the repository until it leaves `connecting` and `fetching` (or is gone). */
    async function settled(projectId: string, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const response = await getRepository(projectId);
        if (response.status === 404) return null;
        expect(response.status).toBe(200);
        if (!['connecting', 'fetching'].includes(response.body.state)) return response.body;
        if (Date.now() > deadline) throw new Error(`the repository stayed ${response.body.state}`);
        await sleep(50);
      }
    }

    const clonesDir = () => join(dataDir, 'clones');
    async function entriesOf(projectId: string) {
      return existsSync(clonesDir())
        ? (await readdir(clonesDir())).filter((name) => name.startsWith(projectId))
        : [];
    }

    async function readyProject(name: string): Promise<string> {
      const id = await createProject(name);
      expect((await connect(id)).status).toBe(201);
      expect(await settled(id)).toMatchObject({ state: 'ready' });
      return id;
    }

    /** A Repository stored as it is after the given operation, without running one. */
    async function insertRepository(
      projectId: string,
      state: 'connecting' | 'fetching' | 'awaiting_key' | 'awaiting_host_key' | 'failed',
      options: { ssh?: boolean } = {},
    ) {
      const ssh = options.ssh || state === 'awaiting_key' || state === 'awaiting_host_key';
      const url = ssh
        ? `git@github.com:acme/${projectId}.git`
        : `https://git.example.test/acme/${projectId}.git`;
      const identity = url.startsWith('git@') ? `github.com/acme/${projectId}` : url.slice(8, -4);
      const clone = state === 'fetching' ? "repeat('a', 40)" : null;
      await db().$executeRawUnsafe(
        `INSERT INTO repositories
           (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at,
            failure_code, failure_detail, deploy_key_secret_id, public_key, pending_host_key)
         VALUES ($1::uuid, $2, $3, 'dev', $4, ${clone}, ${clone ? 'now()' : 'NULL'},
                 ${state === 'failed' ? "'auth_failed'" : 'NULL'},
                 ${state === 'failed' ? "'denied'" : 'NULL'},
                 ${ssh ? 'gen_random_uuid()' : 'NULL'},
                 ${ssh ? "'ssh-ed25519 AAAAplaceholder studio'" : 'NULL'},
                 ${state === 'awaiting_host_key' ? `'${HOST_KEY}'` : 'NULL'})`,
        projectId,
        url,
        identity,
        state,
      );
    }

    beforeAll(async () => {
      if (!linux) return;
      services = await startStudioServices();
      dataDir = await mkdtemp(join(tmpdir(), 'studio-repo-race-data-'));
      fixtures = await mkdtemp(join(tmpdir(), 'studio-repo-race-fixtures-'));
      fixture = createGitFixture(fixtures, 'race-remote');
      services.config = {
        ...services.config,
        dataDir,
        gitAllowFileRemotes: true,
        gitAllowPrivateRemotes: true,
      };
      app = await startStudioApp(services.config);
      cookie = await signIn(app);
    });

    afterAll(async () => {
      await app?.close();
      await services?.stop();
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
      if (fixtures) await rm(fixtures, { recursive: true, force: true });
    });

    it(
      'a disconnect while the clone runs: 204, and nothing of the Repository is left',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const id = await createProject(`Clone race ${i}`);
          expect((await connect(id)).status).toBe(201);
          // Before, during and after the clone: the delay moves the disconnect across it.
          await sleep((i % 5) * 12);

          const response = await disconnect(id);

          expect(response.status, `iteration ${i}`).toBe(204);
          expect((await getRepository(id)).status, `iteration ${i}`).toBe(404);
          // A late write or clone of the cancelled job would show up after a moment.
          await sleep(150);
          expect((await getRepository(id)).status, `iteration ${i}`).toBe(404);
          expect(await entriesOf(id), `iteration ${i}`).toEqual([]);
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'two connects of one project: one 201, one 409, and the winner clones',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const id = await createProject(`Connect race ${i}`);

          const responses = await Promise.all([connect(id), connect(id)]);

          expect(statuses(...responses), `iteration ${i}`).toEqual([201, 409]);
          expect(responses.find((r) => r.status === 409)!.body.type).toBe(
            `${PROBLEM}repository-already-connected`,
          );
          expect(await settled(id), `iteration ${i}`).toMatchObject({ state: 'ready' });
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'two projects connecting the same remote: one 201, one 409 remote-already-connected',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const first = await createProject(`Remote race A ${i}`);
          const second = await createProject(`Remote race B ${i}`);

          const responses = await Promise.all([connect(first), connect(second)]);

          expect(statuses(...responses), `iteration ${i}`).toEqual([201, 409]);
          expect(responses.find((r) => r.status === 409)!.body.type).toBe(
            `${PROBLEM}remote-already-connected`,
          );
          const rows = await db().$queryRaw<
            { n: bigint }[]
          >`SELECT count(*) AS n FROM repositories`;
          expect(Number(rows[0]!.n), `iteration ${i}`).toBe(1);
          const winner = responses[0]!.status === 201 ? first : second;
          expect(await settled(winner), `iteration ${i}`).toMatchObject({ state: 'ready' });
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'two Retries of one failed Repository: one 201, one 409, and the winner clones',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const id = await createProject(`Retry race ${i}`);
          await insertRepository(id, 'failed');

          const responses = await Promise.all([connect(id), connect(id)]);

          expect(statuses(...responses), `iteration ${i}`).toEqual([201, 409]);
          expect(responses.find((r) => r.status === 409)!.body.type).toBe(
            `${PROBLEM}repository-already-connected`,
          );
          expect(await settled(id), `iteration ${i}`).toMatchObject({
            state: 'ready',
            url: fixture.url,
          });
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'a Retry racing a disconnect: the disconnect finishes, the Retry wins only where it came first',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const id = await createProject(`Retry and disconnect ${i}`);
          await insertRepository(id, 'failed');

          const [connected, disconnected] = await Promise.all([connect(id), disconnect(id)]);

          expect(disconnected.status, `iteration ${i}`).toBe(204);
          expect([201, 409], `iteration ${i}`).toContain(connected.status);
          const final = await settled(id);
          if (connected.status === 409) {
            expect(final, `iteration ${i}`).toBeNull();
          } else {
            // Replaced first and then disconnected, or connected again after the disconnect.
            expect(final === null || final.state === 'ready', `iteration ${i}`).toBe(true);
          }
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'two fetches of one Repository: one 202, one 409 repository-busy',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const id = await readyProject(`Fetch race ${i}`);

          const responses = await Promise.all([fetchRepository(id), fetchRepository(id)]);

          expect(statuses(...responses), `iteration ${i}`).toEqual([202, 409]);
          expect(responses.find((r) => r.status === 409)!.body.type).toBe(
            `${PROBLEM}repository-busy`,
          );
          expect(await settled(id), `iteration ${i}`).toMatchObject({ state: 'ready' });
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'a fetch racing a disconnect: the disconnect finishes and nothing is left',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const id = await readyProject(`Fetch and disconnect ${i}`);

          const [fetched, disconnected] = await Promise.all([fetchRepository(id), disconnect(id)]);

          expect(disconnected.status, `iteration ${i}`).toBe(204);
          expect([202, 404, 409], `iteration ${i}`).toContain(fetched.status);
          await sleep(100);
          expect((await getRepository(id)).status, `iteration ${i}`).toBe(404);
          expect(await entriesOf(id), `iteration ${i}`).toEqual([]);
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'two disconnects of one Repository: each answers 204 or 404, one at least 204, nothing is left',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const id = await readyProject(`Disconnect race ${i}`);

          const responses = await Promise.all([disconnect(id), disconnect(id)]);

          for (const response of responses) {
            expect([204, 404], `iteration ${i}`).toContain(response.status);
          }
          expect(
            responses.some((r) => r.status === 204),
            `iteration ${i}`,
          ).toBe(true);
          expect((await getRepository(id)).status, `iteration ${i}`).toBe(404);
          expect(await entriesOf(id), `iteration ${i}`).toEqual([]);
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'two disconnects of an SSH Repository: the Deploy key and host keys are forgotten once, nothing is left',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const id = await createProject(`SSH disconnect race ${i}`);
          await insertRepository(id, 'awaiting_key');
          await db().$executeRawUnsafe(
            `UPDATE repositories SET pinned_host_key = '${HOST_KEY}' WHERE project_id = $1::uuid`,
            id,
          );

          const responses = await Promise.all([disconnect(id), disconnect(id)]);

          for (const response of responses) {
            expect([204, 404], `iteration ${i}`).toContain(response.status);
          }
          expect(
            responses.some((r) => r.status === 204),
            `iteration ${i}`,
          ).toBe(true);
          const rows = await db().$queryRaw<{ n: bigint }[]>`
            SELECT count(*) AS n FROM repositories WHERE project_id = ${id}::uuid`;
          expect(Number(rows[0]!.n), `iteration ${i}`).toBe(0);
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'two instances starting together fail what is still connecting or fetching, once',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const connecting = await createProject(`Reconcile connecting ${i}`);
          const fetching = await createProject(`Reconcile fetching ${i}`);
          await insertRepository(connecting, 'connecting');
          await insertRepository(fetching, 'fetching');

          // Each instance fails the interrupted operations before its workers start.
          const started = await Promise.all([
            startStudioApp({ ...services.config, dataDir: createTestDataDir() }),
            startStudioApp({ ...services.config, dataDir: createTestDataDir() }),
          ]);
          try {
            expect((await getRepository(connecting)).body, `iteration ${i}`).toMatchObject({
              state: 'failed',
              failure: { code: 'interrupted' },
            });
            expect((await getRepository(fetching)).body, `iteration ${i}`).toMatchObject({
              state: 'failed',
              hasClone: true,
              failure: { code: 'interrupted' },
            });
          } finally {
            await Promise.all(started.map((instance) => instance.close()));
          }
        }
      },
      CASE_TIMEOUT,
    );

    it(
      'the start-up reconciliation of another instance racing a disconnect: the disconnect wins',
      async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await freshIteration();
          const connecting = await createProject(`Reconcile and disconnect A ${i}`);
          const fetching = await createProject(`Reconcile and disconnect B ${i}`);
          await insertRepository(connecting, 'connecting');
          await insertRepository(fetching, 'fetching');

          const [instance, first, second] = await Promise.all([
            startStudioApp({ ...services.config, dataDir: createTestDataDir() }),
            disconnect(connecting),
            disconnect(fetching),
          ]);
          await instance.close();

          expect(first.status, `iteration ${i}`).toBe(204);
          expect(second.status, `iteration ${i}`).toBe(204);
          const rows = await db().$queryRaw<
            { n: bigint }[]
          >`SELECT count(*) AS n FROM repositories`;
          expect(Number(rows[0]!.n), `iteration ${i}`).toBe(0);
        }
      },
      CASE_TIMEOUT,
    );

    describe('verification of an SSH Repository', () => {
      it(
        'two confirmations of the same host key: one 202, one refused, and the key is pinned once',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const id = await createProject(`Confirm race ${i}`);
            await insertRepository(id, 'awaiting_host_key');
            const body = { acceptHostKeyFingerprint: hostKeyFingerprint(HOST_KEY) };

            const responses = await Promise.all([verify(id, body), verify(id, body)]);

            expect(statuses(...responses), `iteration ${i}`).toEqual([202, 409]);
            expect(responses.find((r) => r.status === 409)!.body.type).toBe(
              `${PROBLEM}repository-not-verifiable`,
            );
            const rows = await db().$queryRaw<{ pinned: string | null }[]>`
              SELECT pinned_host_key AS pinned FROM repositories WHERE project_id = ${id}::uuid`;
            expect(rows[0]!.pinned, `iteration ${i}`).toBe(HOST_KEY);
          }
        },
        CASE_TIMEOUT,
      );

      it(
        'a confirmation racing a disconnect: the disconnect wins and nothing is left',
        async () => {
          for (let i = 0; i < ITERATIONS; i++) {
            await freshIteration();
            const id = await createProject(`Confirm and disconnect ${i}`);
            await insertRepository(id, 'awaiting_host_key');

            const [confirmed, disconnected] = await Promise.all([
              verify(id, { acceptHostKeyFingerprint: hostKeyFingerprint(HOST_KEY) }),
              disconnect(id),
            ]);

            expect(disconnected.status, `iteration ${i}`).toBe(204);
            expect([202, 404, 409], `iteration ${i}`).toContain(confirmed.status);
            await sleep(100);
            expect((await getRepository(id)).status, `iteration ${i}`).toBe(404);
          }
        },
        CASE_TIMEOUT,
      );
    });

    // Guard against a silent skip: in CI the real-git cases above must run.
    it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI (Linux)', () => {
      expect(process.platform).toBe('linux');
    });
  },
);
