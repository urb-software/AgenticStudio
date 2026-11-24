import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  previewBuildEventsSchema,
  previewBuildSchema,
  previewSchema,
} from '@agentic-studio/contracts';
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

// The Preview build routes on the real app (PostgreSQL and Redis via Testcontainers). The cases
// that read the Compose file need the real `git`, so they run on Linux only.

// Throwaway tokens and values generated per run; none is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const CONTROLLER_TOKEN = randomBytes(32).toString('base64');
const digest = (token: string) => createSecretKey(createHash('sha256').update(token).digest());
const SECRET_VALUE = `pw-${randomBytes(9).toString('hex')}`;
const PREVIEW_DOMAIN = 'preview.example.test';
const PROBLEM = 'urn:agentic-studio:problem:';
const CONTROLLER = randomUUID();
const UNKNOWN_PROJECT = '00000000-0000-4000-8000-000000000000';
const linux = process.platform === 'linux';
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\n';
const PRIVILEGED = 'services:\n  web:\n    image: nginx:1.27\n    privileged: true\n';
const SETTINGS = { composeFile: 'compose.yaml', service: 'web', port: 80 };
const LOG_CAP_BYTES = 300;

function expectProblem(response: request.Response, status: number, type?: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
  if (type) expect(response.body.type).toBe(`${PROBLEM}${type}`);
}

describe('Preview build API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let dataDir: string;
  let app: INestApplication;
  let cookie: string;
  let fixture: GitFixture;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const session = () => ({ Origin: STUDIO_ORIGIN, Cookie: cookie });
  const controllerAuth = { Authorization: `Bearer ${CONTROLLER_TOKEN}` };
  const base = '/api/controller/operations';
  const previewUrl = (projectId: string) => `/api/projects/${projectId}/preview`;
  const requestBuild = (projectId: string) =>
    http()
      .post(`${previewUrl(projectId)}/builds`)
      .set(session());
  const getPreview = (projectId: string) => http().get(previewUrl(projectId)).set('Cookie', cookie);
  const events = (projectId: string, buildId: string, query: object = {}) =>
    http()
      .get(`${previewUrl(projectId)}/builds/${buildId}/events`)
      .query(query)
      .set('Cookie', cookie);
  const claim = () =>
    http().post(`${base}/claim`).set(controllerAuth).send({ controllerId: CONTROLLER });
  const report = (id: string, body: object) =>
    http()
      .post(`${base}/${id}/state`)
      .set(controllerAuth)
      .send({ controllerId: CONTROLLER, ...body });
  const appendLog = (id: string, lines: object[]) =>
    http().post(`${base}/${id}/log`).set(controllerAuth).send({ controllerId: CONTROLLER, lines });
  const line = (seq: number, text: string) => ({
    seq,
    at: '2026-11-24T10:00:00.000Z',
    stream: 'build',
    text,
  });

  async function createProject(): Promise<string> {
    const response = await http()
      .post('/api/projects')
      .set(session())
      .send({ name: `Project ${randomUUID()}` });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  async function readyProject(withSettings = true): Promise<string> {
    const projectId = await createProject();
    const connected = await http()
      .post(`/api/projects/${projectId}/repository`)
      .set(session())
      .send({ url: fixture.url, integrationBranch: 'dev' });
    expect(connected.status).toBe(201);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const repository = await http()
        .get(`/api/projects/${projectId}/repository`)
        .set('Cookie', cookie);
      if (repository.body.state === 'ready') break;
      if (repository.body.state === 'failed' || Date.now() > deadline) {
        throw new Error(`the repository is ${repository.body.state}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (withSettings) {
      const saved = await http()
        .put(`${previewUrl(projectId)}/settings`)
        .set(session())
        .send(SETTINGS);
      expect(saved.status).toBe(200);
    }
    return projectId;
  }

  /** The commit the Clone holds: the fixture's own branch moved when its files were pushed. */
  async function headOf(projectId: string): Promise<string> {
    return (await getPreview(projectId)).body.repository.commit as string;
  }

  async function setEnvironmentFile(projectId: string) {
    const response = await http()
      .put(`/api/projects/${projectId}/environment-file`)
      .set(session())
      .send({ path: '.env', content: `DB_PASSWORD=${SECRET_VALUE}\n` });
    expect(response.status).toBe(200);
  }

  /** A controller call, so that Studio sees a controller; there is nothing to claim. */
  async function connectController() {
    expect((await claim()).status).toBe(204);
  }

  beforeAll(async () => {
    services = await startStudioServices();
    dataDir = await mkdtemp(join(tmpdir(), 'studio-preview-build-http-'));
    services.config = {
      ...services.config,
      dataDir,
      gitAllowFileRemotes: true,
      gitAllowPrivateRemotes: true,
      workerToken: digest(WORKER_TOKEN),
      controllerToken: digest(CONTROLLER_TOKEN),
      controllerLeaseSeconds: 60,
      previewLogMaxBytes: LOG_CAP_BYTES,
      previewDomain: PREVIEW_DOMAIN,
    };
    if (linux) {
      fixture = createGitFixture(dataDir, 'preview-build-source', { branches: ['main', 'dev'] });
      pushFiles(fixture, 'dev', fixture.commits.dev!, {
        'compose.yaml': COMPOSE,
        'privileged.yaml': PRIVILEGED,
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
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
  });

  describe('credentials', () => {
    it('refuses POST /preview/builds to no credential, a worker token and a controller token', async () => {
      const id = await createProject();
      const url = `${previewUrl(id)}/builds`;

      expectProblem(await http().post(url).set('Origin', STUDIO_ORIGIN), 401);
      expectProblem(
        await http()
          .post(url)
          .set({ Origin: STUDIO_ORIGIN, Authorization: `Bearer ${WORKER_TOKEN}` }),
        401,
      );
      expectProblem(
        await http()
          .post(url)
          .set({ Origin: STUDIO_ORIGIN, Authorization: `Bearer ${CONTROLLER_TOKEN}` }),
        401,
      );
      expectProblem(
        await http().post(url).set({ Origin: 'http://evil.example', Cookie: cookie }),
        403,
      );
    });

    it('refuses the events route to no credential, a worker token and a controller token', async () => {
      const id = await createProject();
      const url = `${previewUrl(id)}/builds/${randomUUID()}/events`;

      expectProblem(await http().get(url), 401);
      expectProblem(await http().get(url).set('Authorization', `Bearer ${WORKER_TOKEN}`), 401);
      expectProblem(await http().get(url).set('Authorization', `Bearer ${CONTROLLER_TOKEN}`), 401);
    });

    it('refuses the preview read to a controller token', async () => {
      const id = await createProject();

      expectProblem(
        await http().get(previewUrl(id)).set('Authorization', `Bearer ${CONTROLLER_TOKEN}`),
        401,
      );
    });
  });

  describe('POST /api/projects/:id/preview/builds', () => {
    it('answers 404 for an unknown project and for an id that is not a UUID', async () => {
      expectProblem(await requestBuild(UNKNOWN_PROJECT), 404, 'project-not-found');
      expectProblem(await requestBuild('not-a-uuid'), 404, 'project-not-found');
    });

    it('answers 409 preview-not-configured for a project without settings', async () => {
      const id = await createProject();

      expectProblem(await requestBuild(id), 409, 'preview-not-configured');
    });

    describe.runIf(linux)('with a ready Repository (real git)', () => {
      it('answers 409 preview-controller-unavailable while no controller called', async () => {
        const id = await readyProject();

        expectProblem(await requestBuild(id), 409, 'preview-controller-unavailable');
        expect(await db().previewOperation.count({ where: { projectId: id } })).toBe(0);
      });

      it('queues a build of the commit that was validated, and answers 202', async () => {
        const id = await readyProject();
        await connectController();

        const response = await requestBuild(id);

        expect(response.status).toBe(202);
        expect(previewBuildSchema.safeParse(response.body).success).toBe(true);
        expect(response.body).toMatchObject({
          status: 'queued',
          commit: await headOf(id),
          startedAt: null,
          finishedAt: null,
          timeLimitMinutes: 20,
          failure: null,
          log: { bytes: 0, truncated: false },
        });
        const row = await db().previewOperation.findUniqueOrThrow({
          where: { id: response.body.id as string },
        });
        expect(row).toMatchObject({
          kind: 'build',
          status: 'requested',
          commit: await headOf(id),
          composeFile: 'compose.yaml',
          service: 'web',
          port: 80,
        });
      });

      it('answers 409 preview-build-running for a second build', async () => {
        const id = await readyProject();
        await connectController();
        expect((await requestBuild(id)).status).toBe(202);

        expectProblem(await requestBuild(id), 409, 'preview-build-running');
        expect(await db().previewOperation.count({ where: { projectId: id } })).toBe(1);
      });

      it('answers one 202 and one 409 for two simultaneous requests', async () => {
        const id = await readyProject();
        await connectController();

        const [first, second] = await Promise.all([requestBuild(id), requestBuild(id)]);

        expect([first.status, second.status].sort()).toEqual([202, 409]);
        const refused = first.status === 409 ? first : second;
        expectProblem(refused, 409, 'preview-build-running');
        expect(await db().previewOperation.count({ where: { projectId: id } })).toBe(1);
      });

      it('answers 422 preview-refused with the refusals when the file is refused at this commit', async () => {
        const id = await readyProject(false);
        await db().previewSettings.create({
          data: { projectId: id, composeFile: 'privileged.yaml', service: 'web', port: 80 },
        });
        await connectController();

        const response = await requestBuild(id);

        expectProblem(response, 422, 'preview-refused');
        expect(response.body.refusals).toContainEqual(
          expect.objectContaining({ code: 'privileged', place: 'services.web.privileged' }),
        );
        expect(await db().previewOperation.count({ where: { projectId: id } })).toBe(0);
      });

      it('answers 422 compose_file_missing when the file is gone from the commit', async () => {
        const id = await readyProject(false);
        await db().previewSettings.create({
          data: { projectId: id, composeFile: 'gone.yaml', service: 'web', port: 80 },
        });
        await connectController();

        const response = await requestBuild(id);

        expectProblem(response, 422, 'preview-refused');
        expect(response.body.refusals).toEqual([
          expect.objectContaining({ code: 'compose_file_missing', place: 'composeFile' }),
        ]);
      });
    });

    it('answers 409 preview-repository-not-ready while the project has no repository', async () => {
      const id = await createProject();
      await db().previewSettings.create({
        data: { projectId: id, composeFile: 'compose.yaml', service: 'web', port: 80 },
      });
      await connectController();

      expectProblem(await requestBuild(id), 409, 'preview-repository-not-ready');
    });
  });

  describe.runIf(linux)('the state and the log of a build (real git)', () => {
    async function claimedBuild(projectId: string) {
      const queued = await requestBuild(projectId);
      expect(queued.status).toBe(202);
      const claimed = await claim();
      expect(claimed.status).toBe(200);
      expect(claimed.body.operationId).toBe(queued.body.id);
      return queued.body.id as string;
    }

    it('shows the Preview as building, then running with the commit and the link', async () => {
      const id = await readyProject();
      await connectController();
      const before = await getPreview(id);
      expect(previewSchema.safeParse(before.body).success).toBe(true);
      expect(before.body).toMatchObject({ state: 'stopped', controller: { connected: true } });

      const buildId = await claimedBuild(id);
      const during = await getPreview(id);
      expect(during.body).toMatchObject({
        state: 'building',
        latestBuild: { id: buildId, status: 'building' },
      });

      await report(buildId, {
        state: 'succeeded',
        runtime: { services: [{ name: 'web', state: 'running' }] },
      });
      const after = await getPreview(id);
      expect(after.body).toMatchObject({
        state: 'running',
        latestBuild: { id: buildId, status: 'succeeded' },
        running: {
          buildId,
          commit: await headOf(id),
          url: `https://preview-${id.replace(/-/g, '').slice(0, 12)}.${PREVIEW_DOMAIN}/`,
        },
      });
    });

    it('keeps the Preview running when a later build fails, and is failed when the failure removed it', async () => {
      const id = await readyProject();
      await connectController();
      const first = await claimedBuild(id);
      await report(first, { state: 'succeeded' });

      const second = await claimedBuild(id);
      await report(second, {
        state: 'failed',
        failure: { code: 'build_failed', detail: 'exit 1' },
      });
      const kept = await getPreview(id);
      expect(kept.body).toMatchObject({
        state: 'running',
        running: { buildId: first },
        latestBuild: { id: second, status: 'failed', failure: { previewRemoved: false } },
      });

      const third = await claimedBuild(id);
      await report(third, {
        state: 'failed',
        failure: { code: 'start_failed', detail: 'no start', previewRemoved: true },
      });
      const removed = await getPreview(id);
      expect(removed.body).toMatchObject({
        state: 'failed',
        running: null,
        latestBuild: { id: third, failure: { code: 'start_failed', previewRemoved: true } },
      });
    });

    it('refuses to remove the settings while a build runs and while the Preview runs', async () => {
      const id = await readyProject();
      await connectController();
      const buildId = await claimedBuild(id);
      const remove = () =>
        http()
          .delete(`${previewUrl(id)}/settings`)
          .set(session());

      expectProblem(await remove(), 409, 'preview-build-running');
      await report(buildId, { state: 'succeeded' });
      expectProblem(await remove(), 409, 'preview-running');
    });

    it('pages the log until final, with next on every page but the last', async () => {
      const id = await readyProject();
      await connectController();
      const buildId = await claimedBuild(id);
      await appendLog(buildId, [line(1, 'one'), line(2, 'two'), line(3, 'three')]);

      const first = await events(id, buildId, { limit: 2 });
      expect(first.status).toBe(200);
      expect(previewBuildEventsSchema.safeParse(first.body).success).toBe(true);
      expect(first.body.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2]);
      expect(first.body).toMatchObject({ next: 2, final: false, truncated: false });

      const last = await events(id, buildId, { after: first.body.next, limit: 2 });
      expect(last.body.events.map((event: { seq: number }) => event.seq)).toEqual([3]);
      expect(last.body).not.toHaveProperty('next');
      expect(last.body.final).toBe(false);

      await report(buildId, { state: 'succeeded' });
      expect((await events(id, buildId, { after: 3 })).body).toMatchObject({
        events: [],
        final: true,
      });
    });

    it('marks the truncation when the log reached its cap', async () => {
      const id = await readyProject();
      await connectController();
      const buildId = await claimedBuild(id);
      await appendLog(buildId, [line(1, 'x'.repeat(200)), line(2, 'y'.repeat(200))]);

      const page = await events(id, buildId);

      expect(page.body.truncated).toBe(true);
      expect((await getPreview(id)).body.latestBuild.log.truncated).toBe(true);
    });

    it('answers 400 for after or limit out of range', async () => {
      const id = await readyProject();
      const buildId = randomUUID();

      expectProblem(await events(id, buildId, { limit: 1001 }), 400);
      expectProblem(await events(id, buildId, { limit: 0 }), 400);
      expectProblem(await events(id, buildId, { after: -1 }), 400);
    });

    it('answers 404 for an unknown project, an unknown build, a stop and another project', async () => {
      const id = await readyProject();
      const other = await createProject();
      await connectController();
      const buildId = await claimedBuild(id);
      const stop = await db().previewOperation.create({
        data: { projectId: id, kind: 'stop', status: 'requested' },
      });

      expectProblem(await events(UNKNOWN_PROJECT, buildId), 404, 'project-not-found');
      expectProblem(await events(id, randomUUID()), 404, 'preview-build-not-found');
      expectProblem(await events(id, 'not-a-uuid'), 404, 'preview-build-not-found');
      expectProblem(await events(id, stop.id), 404, 'preview-build-not-found');
      expectProblem(await events(other, buildId), 404, 'preview-build-not-found');
    });

    it('puts no Environment file value in any operator answer', async () => {
      const id = await readyProject();
      await setEnvironmentFile(id);
      await connectController();
      const queued = await requestBuild(id);
      const claimed = await claim();
      expect(claimed.body.environmentFile.content).toContain(SECRET_VALUE);
      const buildId = queued.body.id as string;
      await appendLog(buildId, [line(1, `connecting with ${SECRET_VALUE}`)]);
      await report(buildId, {
        state: 'failed',
        failure: { code: 'build_failed', detail: `the password ${SECRET_VALUE} was refused` },
      });

      const answers = [
        JSON.stringify(queued.body),
        JSON.stringify((await getPreview(id)).body),
        JSON.stringify((await events(id, buildId)).body),
      ];

      for (const answer of answers) expect(answer).not.toContain(SECRET_VALUE);
      const page = (await events(id, buildId)).body;
      expect(page.events[0]).toMatchObject({ redacted: true });
      expect((await getPreview(id)).body.latestBuild.failure.detail).toContain('redacted');
    });
  });
});
