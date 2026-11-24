import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import { createGitFixture, type GitFixture, pushFiles } from './git-fixture.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// A Project's Preview settings over HTTP on the real app (PostgreSQL and Redis via
// Testcontainers). The cases that read the Compose file need the real `git`, so they run on Linux
// only, with a `file://` fixture remote accepted under a test-only setting.

// A throwaway worker token generated per run; none is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const PREVIEW_DOMAIN = 'preview.example.test';
const PROBLEM = 'urn:agentic-studio:problem:';
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNKNOWN_PROJECT = '00000000-0000-4000-8000-000000000000';
const linux = process.platform === 'linux';

const COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\n';
const PRIVILEGED = 'services:\n  web:\n    image: nginx:1.27\n    privileged: true\n';
// Over the 256 KiB the validation reads: a comment line keeps it valid YAML.
const TOO_LARGE = `# ${'a'.repeat(256 * 1024)}\n${COMPOSE}`;
const BODY = { composeFile: 'compose.yaml', service: 'web', port: 80 };

function expectProblem(response: request.Response, status: number, type?: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
  if (type) expect(response.body.type).toBe(`${PROBLEM}${type}`);
}

describe('Preview settings API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let dataDir: string;
  let app: INestApplication;
  let cookie: string;
  let fixture: GitFixture;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const mutate = { Origin: STUDIO_ORIGIN } as const;
  const previewUrl = (projectId: string) => `/api/projects/${projectId}/preview`;
  const get = (projectId: string) => http().get(previewUrl(projectId)).set('Cookie', cookie);
  const put = (projectId: string, body: object) =>
    http()
      .put(`${previewUrl(projectId)}/settings`)
      .set({ ...mutate, Cookie: cookie })
      .send(body);
  const remove = (projectId: string) =>
    http()
      .delete(`${previewUrl(projectId)}/settings`)
      .set({ ...mutate, Cookie: cookie });

  async function createProject(): Promise<string> {
    const response = await http()
      .post('/api/projects')
      .set({ ...mutate, Cookie: cookie })
      .send({ name: `Project ${randomUUID()}` });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  /** A project whose Repository is cloned from the fixture's `dev` branch and ready. */
  async function readyProject(): Promise<string> {
    const projectId = await createProject();
    const connected = await http()
      .post(`/api/projects/${projectId}/repository`)
      .set({ ...mutate, Cookie: cookie })
      .send({ url: fixture.url, integrationBranch: 'dev' });
    expect(connected.status).toBe(201);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const repository = await http()
        .get(`/api/projects/${projectId}/repository`)
        .set('Cookie', cookie);
      if (repository.body.state === 'ready') return projectId;
      if (repository.body.state === 'failed' || Date.now() > deadline) {
        throw new Error(`the repository is ${repository.body.state}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  beforeAll(async () => {
    services = await startStudioServices();
    dataDir = await mkdtemp(join(tmpdir(), 'studio-preview-http-'));
    services.config = {
      ...services.config,
      dataDir,
      gitAllowFileRemotes: true,
      gitAllowPrivateRemotes: true,
      workerToken: WORKER_TOKEN_DIGEST,
      previewDomain: PREVIEW_DOMAIN,
    };
    if (linux) {
      fixture = createGitFixture(dataDir, 'preview-source', { branches: ['main', 'dev'] });
      pushFiles(fixture, 'dev', fixture.commits.dev!, {
        'compose.yaml': COMPOSE,
        'deploy/compose.yaml': COMPOSE,
        'privileged.yaml': PRIVILEGED,
        'too-large.yaml': TOO_LARGE,
      });
    }
    app = await startStudioApp(services.config);
    cookie = await signIn(app);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Test isolation only; CASCADE also empties repositories and preview_settings.
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
  });

  describe('the three routes are operator routes', () => {
    it('refuse no session, a foreign origin and the worker token', async () => {
      const id = await createProject();
      const worker = { Authorization: `Bearer ${WORKER_TOKEN}` };
      const url = `${previewUrl(id)}`;

      expectProblem(await http().get(url), 401);
      expectProblem(await http().get(url).set(worker), 401);
      expectProblem(await http().put(`${url}/settings`).set(mutate).send(BODY), 401);
      expectProblem(
        await http()
          .put(`${url}/settings`)
          .set({ ...mutate, ...worker })
          .send(BODY),
        401,
      );
      expectProblem(
        await http()
          .put(`${url}/settings`)
          .set({ Origin: 'http://evil.example', Cookie: cookie })
          .send(BODY),
        403,
      );
      expectProblem(await http().delete(`${url}/settings`).set(mutate), 401);
      expectProblem(
        await http()
          .delete(`${url}/settings`)
          .set({ ...mutate, ...worker }),
        401,
      );
      expectProblem(
        await http()
          .delete(`${url}/settings`)
          .set({ Origin: 'http://evil.example', Cookie: cookie }),
        403,
      );
    });
  });

  describe('GET /api/projects/:id/preview', () => {
    it('shows no settings, the hostname and why the Repository is not ready', async () => {
      const id = await createProject();

      const response = await get(id);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        settings: null,
        hostname: `preview-${id.replace(/-/g, '').slice(0, 12)}.${PREVIEW_DOMAIN}`,
        repository: { ready: false, reason: 'no_repository' },
        state: 'not_configured',
        running: null,
        latestBuild: null,
        latestChange: null,
        controller: { connected: false },
      });
    });

    it('says the hostname is not configured while no preview domain is set', async () => {
      const id = await createProject();
      await app.close();
      app = await startStudioApp({ ...services.config, previewDomain: null });
      cookie = await signIn(app);

      const response = await get(id);

      expect(response.body).toMatchObject({
        hostname: null,
        hostnameUnavailable: 'not_configured',
      });
      await app.close();
      app = await startStudioApp(services.config);
      cookie = await signIn(app);
    });

    it('answers 404 for an unknown project and for an id that is not a UUID', async () => {
      expectProblem(await get(UNKNOWN_PROJECT), 404, 'project-not-found');
      expectProblem(await get('not-a-uuid'), 404, 'project-not-found');
    });
  });

  describe('PUT and DELETE /api/projects/:id/preview/settings', () => {
    it('answers 404 for an unknown project and for an id that is not a UUID', async () => {
      expectProblem(await put(UNKNOWN_PROJECT, BODY), 404, 'project-not-found');
      expectProblem(await put('not-a-uuid', BODY), 404, 'project-not-found');
      expectProblem(await remove(UNKNOWN_PROJECT), 404, 'project-not-found');
      expectProblem(await remove('not-a-uuid'), 404, 'project-not-found');
    });

    it('answers 400 for a request with the wrong shape, naming the field', async () => {
      const id = await createProject();

      const missing = await put(id, { composeFile: 'compose.yaml', service: 'web' });
      expectProblem(missing, 400);
      expect(missing.body.errors).toContainEqual({ path: 'port', message: expect.any(String) });
      expectProblem(await put(id, { ...BODY, port: 0 }), 400);
      expectProblem(await put(id, { ...BODY, port: '80' }), 400);
      expectProblem(await put(id, { ...BODY, service: '-web' }), 400);
      expectProblem(await put(id, { ...BODY, extra: true }), 400);
    });

    it('answers 409 while the project has no repository', async () => {
      const id = await createProject();

      expectProblem(await put(id, BODY), 409, 'preview-repository-not-ready');
    });

    it('removes settings that were never set with 204', async () => {
      const id = await createProject();

      expect((await remove(id)).status).toBe(204);
    });

    describe.runIf(linux)('with a ready Repository (real git)', () => {
      it('saves what the validation accepts, shows it, changes it and removes it', async () => {
        const id = await readyProject();

        const saved = await put(id, BODY);
        expect(saved.status).toBe(200);
        expect(saved.body).toEqual({
          settings: { ...BODY, updatedAt: expect.stringMatching(ISO_8601) },
          hostname: `preview-${id.replace(/-/g, '').slice(0, 12)}.${PREVIEW_DOMAIN}`,
          repository: { ready: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/) },
          state: 'stopped',
          running: null,
          latestBuild: null,
          latestChange: null,
          controller: { connected: false },
          removedPorts: [{ service: 'web', place: 'services.web.ports[0]' }],
        });
        const { removedPorts, ...preview } = saved.body;
        expect(removedPorts).toHaveLength(1);
        expect((await get(id)).body).toEqual(preview);
        const rows = await db().$queryRaw<
          { n: bigint }[]
        >`SELECT count(*) AS n FROM preview_settings`;
        expect(Number(rows[0]!.n)).toBe(1);

        const changed = await put(id, {
          composeFile: 'deploy/compose.yaml',
          service: 'web',
          port: 8080,
        });
        expect(changed.status).toBe(200);
        expect(changed.body.settings).toMatchObject({
          composeFile: 'deploy/compose.yaml',
          port: 8080,
        });
        expect((await get(id)).body.settings).toMatchObject({ port: 8080 });
        const afterChange = await db().$queryRaw<
          { n: bigint }[]
        >`SELECT count(*) AS n FROM preview_settings`;
        expect(Number(afterChange[0]!.n)).toBe(1);

        expect((await remove(id)).status).toBe(204);
        expect((await get(id)).body.settings).toBeNull();
        expect((await remove(id)).status).toBe(204);
      });

      it('goes with the project: deleting the project deletes the settings', async () => {
        const id = await readyProject();
        expect((await put(id, BODY)).status).toBe(200);

        await db().$executeRaw`DELETE FROM projects WHERE id = ${id}::uuid`;

        const rows = await db().$queryRaw<
          { n: bigint }[]
        >`SELECT count(*) AS n FROM preview_settings`;
        expect(Number(rows[0]!.n)).toBe(0);
      });

      it('shows a refusal of the validation as 422 with its code and place, and saves nothing', async () => {
        const id = await readyProject();

        const response = await put(id, { ...BODY, composeFile: 'privileged.yaml' });

        expectProblem(response, 422, 'preview-refused');
        expect(response.body.refusals).toEqual([
          { code: 'privileged', place: 'services.web.privileged', message: expect.any(String) },
        ]);
        expect((await get(id)).body.settings).toBeNull();
      });

      it('refuses a service the file does not have', async () => {
        const id = await readyProject();

        const response = await put(id, { ...BODY, service: 'api' });

        expectProblem(response, 422, 'preview-refused');
        expect(response.body.refusals).toEqual([
          expect.objectContaining({ code: 'entry_service_missing' }),
        ]);
      });

      it.each([
        ['a file that is not there', 'nope.yaml', 'compose_file_missing'],
        ['a directory', 'deploy', 'compose_file_missing'],
        ['a file over 256 KiB', 'too-large.yaml', 'compose_file_too_large'],
        ['a path with ..', '../compose.yaml', 'invalid_path'],
        ['an absolute path', '/etc/passwd', 'invalid_path'],
        ['a path with a backslash', 'deploy\\compose.yaml', 'invalid_path'],
        ['a path with a leading ./', './compose.yaml', 'invalid_path'],
      ])('refuses %s with %s at composeFile', async (_name, composeFile, code) => {
        const id = await readyProject();

        const response = await put(id, { ...BODY, composeFile });

        expectProblem(response, 422, 'preview-refused');
        expect(response.body.refusals).toEqual([
          { code, place: 'composeFile', message: expect.any(String) },
        ]);
      });
    });
  });
});
