import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  previewLimitReachedProblemSchema,
  previewSchema,
  previewsListSchema,
} from '@agentic-studio/contracts';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SweepPreviewOperationsHandler } from '../../../application/features/sweep-preview-operations/handler.js';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../../platform/database/database.module.js';
import { problemDetailsSchema } from '../../../../../platform/http/problem-details.js';
import { createGitFixture, pushFiles } from '../../../../../__tests__/git-fixture.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from '../../../../../__tests__/studio-test-app.js';

// The Preview stop, reset, limit and disconnect routes on the real app (PostgreSQL and Redis via
// Testcontainers). The cases that read the Compose file need the real `git`: Linux only.

// Throwaway tokens generated per run; none is committed.
const CONTROLLER_TOKEN = randomBytes(32).toString('base64');
const digest = (token: string) => createSecretKey(createHash('sha256').update(token).digest());
const PROBLEM = 'urn:agentic-studio:problem:';
const CONTROLLER = randomUUID();
const UNKNOWN_PROJECT = '00000000-0000-4000-8000-000000000000';
const linux = process.platform === 'linux';
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\n';
const SETTINGS = { composeFile: 'compose.yaml', service: 'web', port: 80 };
const COMMIT = 'a'.repeat(40);

function expectProblem(response: request.Response, status: number, type?: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
  if (type) expect(response.body.type).toBe(`${PROBLEM}${type}`);
}

describe('Preview stop, reset and limit API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let dataDir: string;
  let app: INestApplication;
  let cookie: string;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const session = () => ({ Origin: STUDIO_ORIGIN, Cookie: cookie });
  const controllerAuth = { Authorization: `Bearer ${CONTROLLER_TOKEN}` };
  const base = '/api/controller/operations';
  const previewUrl = (projectId: string) => `/api/projects/${projectId}/preview`;
  const stop = (projectId: string) =>
    http()
      .post(`${previewUrl(projectId)}/stop`)
      .set(session());
  const reset = (projectId: string) =>
    http()
      .post(`${previewUrl(projectId)}/reset-data`)
      .set(session());
  const getPreview = (projectId: string) => http().get(previewUrl(projectId)).set('Cookie', cookie);
  const claim = () =>
    http().post(`${base}/claim`).set(controllerAuth).send({ controllerId: CONTROLLER });
  const report = (id: string, body: object) =>
    http()
      .post(`${base}/${id}/state`)
      .set(controllerAuth)
      .send({ controllerId: CONTROLLER, ...body });

  async function createProject(): Promise<string> {
    const response = await http()
      .post('/api/projects')
      .set(session())
      .send({ name: `Project ${randomUUID()}` });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  async function readyProject(): Promise<string> {
    const projectId = await createProject();
    const own = createGitFixture(dataDir, `preview-stop-reset-${randomUUID()}`, {
      branches: ['main', 'dev'],
    });
    pushFiles(own, 'dev', own.commits.dev!, { 'compose.yaml': COMPOSE });
    const connected = await http()
      .post(`/api/projects/${projectId}/repository`)
      .set(session())
      .send({ url: own.url, integrationBranch: 'dev' });
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
    const saved = await http()
      .put(`${previewUrl(projectId)}/settings`)
      .set(session())
      .send(SETTINGS);
    expect(saved.status).toBe(200);
    return projectId;
  }

  /** A Preview that runs: a succeeded build the controller once claimed. */
  async function seedRunning(projectId: string, requestedMinutesAgo = 30) {
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    await db().previewSettings.upsert({
      where: { projectId },
      create: { projectId, composeFile: 'compose.yaml', service: 'web', port: 80 },
      update: {},
    });
    return db().previewOperation.create({
      data: {
        projectId,
        kind: 'build',
        status: 'succeeded',
        commit: COMMIT,
        composeFile: 'compose.yaml',
        service: 'web',
        port: 80,
        memoryMiB: 1024,
        cpuPercent: 100,
        tasksMax: 512,
        buildMinutes: 20,
        requestedAt: at(requestedMinutesAgo),
        claimedBy: randomUUID(),
        claimedAt: at(requestedMinutesAgo - 1),
        finishedAt: at(requestedMinutesAgo - 5),
      },
    });
  }

  /** A controller call, so that Studio sees a controller; there is nothing to claim. */
  async function connectController() {
    expect((await claim()).status).toBe(204);
  }

  beforeAll(async () => {
    services = await startStudioServices();
    dataDir = await mkdtemp(join(tmpdir(), 'studio-preview-stop-reset-http-'));
    services.config = {
      ...services.config,
      dataDir,
      gitAllowFileRemotes: true,
      gitAllowPrivateRemotes: true,
      controllerToken: digest(CONTROLLER_TOKEN),
      controllerLeaseSeconds: 60,
      previewDomain: 'preview.example.test',
    };
    app = await startStudioApp(services.config, {
      environments: { sweeps: false },
      projects: { disconnectRetryMs: 300 },
    });
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
    it('refuses the new routes to no credential, a controller token and a foreign Origin', async () => {
      const id = await createProject();

      for (const path of [`${previewUrl(id)}/stop`, `${previewUrl(id)}/reset-data`]) {
        expectProblem(await http().post(path).set('Origin', STUDIO_ORIGIN), 401);
        expectProblem(
          await http()
            .post(path)
            .set({ Origin: STUDIO_ORIGIN, Authorization: `Bearer ${CONTROLLER_TOKEN}` }),
          401,
        );
        expectProblem(
          await http().post(path).set({ Origin: 'http://evil.example', Cookie: cookie }),
          403,
        );
      }
      expectProblem(await http().get('/api/previews'), 401);
      expectProblem(
        await http().get('/api/previews').set('Authorization', `Bearer ${CONTROLLER_TOKEN}`),
        401,
      );
    });
  });

  describe('POST /api/projects/:id/preview/stop', () => {
    it('answers 404 for an unknown project and for an id that is not a UUID', async () => {
      expectProblem(await stop(UNKNOWN_PROJECT), 404, 'project-not-found');
      expectProblem(await stop('not-a-uuid'), 404, 'project-not-found');
    });

    it('answers 409 preview-controller-unavailable while no controller called', async () => {
      const id = await createProject();
      await seedRunning(id);
      const fresh = await startStudioApp(services.config, {
        environments: { sweeps: false },
        projects: { disconnectRetries: false },
      });
      try {
        const answer = await request(fresh.getHttpServer())
          .post(`${previewUrl(id)}/stop`)
          .set({ Origin: STUDIO_ORIGIN, Cookie: await signIn(fresh) });
        expectProblem(answer, 409, 'preview-controller-unavailable');
      } finally {
        await fresh.close();
      }
    });

    it('answers 409 preview-not-running for a Preview that was never built and one that failed', async () => {
      const id = await createProject();
      await connectController();
      expectProblem(await stop(id), 409, 'preview-not-running');

      await db().previewOperation.create({
        data: {
          projectId: id,
          kind: 'build',
          status: 'failed',
          commit: COMMIT,
          composeFile: 'compose.yaml',
          service: 'web',
          port: 80,
          memoryMiB: 1024,
          cpuPercent: 100,
          tasksMax: 512,
          buildMinutes: 20,
          claimedBy: randomUUID(),
          claimedAt: new Date(),
          finishedAt: new Date(),
          failureCode: 'build_failed',
          failureDetail: 'x',
        },
      });
      expectProblem(await stop(id), 409, 'preview-not-running');
    });

    it('queues a stop and answers 202 with the Preview stopping, then stopped once it succeeded', async () => {
      const id = await createProject();
      await seedRunning(id);
      await connectController();

      const response = await stop(id);

      expect(response.status).toBe(202);
      expect(previewSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({
        state: 'stopping',
        latestChange: { kind: 'stop', status: 'queued', finishedAt: null, failure: null },
      });
      expect(await db().previewOperation.count({ where: { projectId: id, kind: 'stop' } })).toBe(1);

      const claimed = await claim();
      expect(claimed.body).toMatchObject({ kind: 'stop', projectId: id });
      expect((await getPreview(id)).body.latestChange.status).toBe('in_progress');

      await report(claimed.body.operationId as string, { state: 'succeeded' });
      expect((await getPreview(id)).body).toMatchObject({
        state: 'stopped',
        running: null,
        latestChange: { kind: 'stop', status: 'succeeded' },
      });
    });

    it('keeps the Preview running and shows the failure when the stop failed', async () => {
      const id = await createProject();
      await seedRunning(id);
      await connectController();
      expect((await stop(id)).status).toBe(202);
      const claimed = await claim();

      await report(claimed.body.operationId as string, {
        state: 'failed',
        failure: { code: 'runtime_failed', detail: 'Docker could not remove resources.' },
      });

      expect((await getPreview(id)).body).toMatchObject({
        state: 'running',
        latestChange: {
          kind: 'stop',
          status: 'failed',
          failure: { code: 'runtime_failed', detail: 'Docker could not remove resources.' },
        },
      });
    });

    it('answers one 202 and one 409 preview-busy for two simultaneous stops', async () => {
      const id = await createProject();
      await seedRunning(id);
      await connectController();

      const [first, second] = await Promise.all([stop(id), stop(id)]);

      expect([first.status, second.status].sort()).toEqual([202, 409]);
      expectProblem(first.status === 409 ? first : second, 409, 'preview-busy');
      expect(await db().previewOperation.count({ where: { projectId: id, kind: 'stop' } })).toBe(1);
    });

    it('answers 409 preview-build-running during a build, and preview-busy during a reset', async () => {
      const building = await createProject();
      await seedRunning(building);
      await db().previewOperation.create({
        data: {
          projectId: building,
          kind: 'build',
          status: 'claimed',
          commit: COMMIT,
          composeFile: 'compose.yaml',
          service: 'web',
          port: 80,
          memoryMiB: 1024,
          cpuPercent: 100,
          tasksMax: 512,
          buildMinutes: 20,
          claimedBy: randomUUID(),
          claimedAt: new Date(),
          heartbeatAt: new Date(),
        },
      });
      const resetting = await createProject();
      await seedRunning(resetting);
      await connectController();

      expectProblem(await stop(building), 409, 'preview-build-running');
      expect((await reset(resetting)).status).toBe(202);
      expectProblem(await stop(resetting), 409, 'preview-busy');
    });
  });

  describe('POST /api/projects/:id/preview/reset-data', () => {
    it('answers 404 for an unknown project and for an id that is not a UUID', async () => {
      expectProblem(await reset(UNKNOWN_PROJECT), 404, 'project-not-found');
      expectProblem(await reset('not-a-uuid'), 404, 'project-not-found');
    });

    it('answers 409 preview-controller-unavailable while no controller called', async () => {
      const id = await createProject();
      const fresh = await startStudioApp(services.config, {
        environments: { sweeps: false },
        projects: { disconnectRetries: false },
      });
      try {
        const answer = await request(fresh.getHttpServer())
          .post(`${previewUrl(id)}/reset-data`)
          .set({ Origin: STUDIO_ORIGIN, Cookie: await signIn(fresh) });
        expectProblem(answer, 409, 'preview-controller-unavailable');
      } finally {
        await fresh.close();
      }
    });

    it('removes the data of a running Preview, then rebuilds the commit it ran, in order', async () => {
      const id = await createProject();
      const running = await seedRunning(id);
      await connectController();

      const response = await reset(id);

      expect(response.status).toBe(202);
      expect(previewSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({
        state: 'resetting_data',
        latestChange: { kind: 'reset_data', status: 'queued' },
      });
      const rows = await db().previewOperation.findMany({
        where: { projectId: id, status: 'requested' },
        orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      });
      expect(rows.map((row) => row.kind)).toEqual(['remove_data', 'build']);
      expect(rows[1]).toMatchObject({
        commit: running.commit,
        composeFile: running.composeFile,
        service: running.service,
        port: running.port,
      });

      const removal = await claim();
      expect(removal.body).toMatchObject({ kind: 'remove_data', projectId: id });
      expect((await claim()).status).toBe(204);
      await report(removal.body.operationId as string, { state: 'succeeded' });
      const rebuild = await claim();
      expect(rebuild.body).toMatchObject({ kind: 'build', commit: running.commit });
      await report(rebuild.body.operationId as string, {
        state: 'succeeded',
        runtime: { services: [{ name: 'web', state: 'running' }] },
      });
      expect((await getPreview(id)).body).toMatchObject({
        state: 'running',
        running: { buildId: rebuild.body.operationId, commit: running.commit },
        latestChange: { kind: 'reset_data', status: 'succeeded' },
      });
    });

    it('takes the data of a Preview that does not run, with no build and no settings', async () => {
      const id = await createProject();
      await connectController();

      const response = await reset(id);

      expect(response.status).toBe(202);
      expect(response.body.state).toBe('resetting_data');
      const rows = await db().previewOperation.findMany({ where: { projectId: id } });
      expect(rows.map((row) => row.kind)).toEqual(['remove_data']);
    });

    it('answers 409 preview-build-running during a build and preview-busy for a second reset', async () => {
      const building = await createProject();
      await db().previewOperation.create({
        data: {
          projectId: building,
          kind: 'build',
          status: 'claimed',
          commit: COMMIT,
          composeFile: 'compose.yaml',
          service: 'web',
          port: 80,
          memoryMiB: 1024,
          cpuPercent: 100,
          tasksMax: 512,
          buildMinutes: 20,
          claimedBy: randomUUID(),
          claimedAt: new Date(),
          heartbeatAt: new Date(),
        },
      });
      const resetting = await createProject();
      await connectController();

      expectProblem(await reset(building), 409, 'preview-build-running');
      expect((await reset(resetting)).status).toBe(202);
      expectProblem(await reset(resetting), 409, 'preview-busy');
    });
  });

  describe('GET /api/previews', () => {
    it('answers the limit and the Projects that run or build, and no one else', async () => {
      const running = await createProject();
      const stopped = await createProject();
      const idle = await createProject();
      await seedRunning(running);
      await seedRunning(stopped);
      await db().previewOperation.create({
        data: {
          projectId: stopped,
          kind: 'stop',
          status: 'succeeded',
          claimedBy: randomUUID(),
          claimedAt: new Date(),
          finishedAt: new Date(),
        },
      });

      const response = await http().get('/api/previews').set('Cookie', cookie);

      expect(response.status).toBe(200);
      expect(previewsListSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toEqual({
        limit: 3,
        previews: [{ projectId: running, state: 'running' }],
      });
      expect(JSON.stringify(response.body)).not.toContain(idle);
    });
  });

  describe('the state check after a lost build', () => {
    async function lostBuild(projectId: string) {
      await seedRunning(projectId, 60);
      await db().previewOperation.create({
        data: {
          projectId,
          kind: 'build',
          status: 'claimed',
          commit: COMMIT,
          composeFile: 'compose.yaml',
          service: 'web',
          port: 80,
          memoryMiB: 1024,
          cpuPercent: 100,
          tasksMax: 512,
          buildMinutes: 20,
          claimedBy: randomUUID(),
          claimedAt: new Date(Date.now() - 10 * 60_000),
          heartbeatAt: new Date(Date.now() - 5 * 60_000),
        },
      });
      await app.get(SweepPreviewOperationsHandler).execute();
    }

    it('shows the Preview as no longer running when the controller finds nothing', async () => {
      const id = await createProject();
      await lostBuild(id);
      expect((await getPreview(id)).body).toMatchObject({
        state: 'running',
        latestBuild: {
          status: 'failed',
          failure: { code: 'controller_lost', previewRemoved: false },
        },
      });
      const check = await claim();
      expect(check.body).toMatchObject({ kind: 'state', projectId: id });

      await report(check.body.operationId as string, {
        state: 'succeeded',
        runtime: { services: [] },
      });

      expect((await getPreview(id)).body).toMatchObject({ state: 'failed', running: null });
      expect(
        await db().previewOperation.findUniqueOrThrow({ where: { id: check.body.operationId } }),
      ).toMatchObject({ previewRemoved: true });
    });

    it('leaves the Preview running when the controller finds it up, and asks only once', async () => {
      const id = await createProject();
      await lostBuild(id);
      await app.get(SweepPreviewOperationsHandler).execute();
      expect(await db().previewOperation.count({ where: { projectId: id, kind: 'state' } })).toBe(
        1,
      );
      const check = await claim();

      await report(check.body.operationId as string, {
        state: 'succeeded',
        runtime: { services: [{ name: 'web', state: 'running' }] },
      });

      expect((await getPreview(id)).body).toMatchObject({ state: 'running' });
      await app.get(SweepPreviewOperationsHandler).execute();
      expect(await db().previewOperation.count({ where: { projectId: id, kind: 'state' } })).toBe(
        1,
      );
    });
  });

  describe.runIf(linux)('the running limit (real git)', () => {
    let limited: INestApplication;
    let limitedCookie: string;

    beforeAll(async () => {
      limited = await startStudioApp(
        { ...services.config, previewMaxRunning: 1 },
        { environments: { sweeps: false }, projects: { disconnectRetries: false } },
      );
      limitedCookie = await signIn(limited);
    });

    afterAll(async () => {
      await limited?.close();
    });

    const limitedHttp = () => request(limited.getHttpServer());
    const limitedSession = () => ({ Origin: STUDIO_ORIGIN, Cookie: limitedCookie });
    const limitedBuild = (projectId: string) =>
      limitedHttp()
        .post(`${previewUrl(projectId)}/builds`)
        .set(limitedSession());
    const limitedClaim = () =>
      limitedHttp().post(`${base}/claim`).set(controllerAuth).send({ controllerId: CONTROLLER });

    it('refuses a build when every place is taken, naming who holds it, and accepts a rebuild', async () => {
      const first = await readyProject();
      const second = await readyProject();
      expect((await limitedClaim()).status).toBe(204);

      const accepted = await limitedBuild(first);
      expect(accepted.status).toBe(202);
      const refused = await limitedBuild(second);

      expectProblem(refused, 409, 'preview-limit-reached');
      expect(previewLimitReachedProblemSchema.safeParse(refused.body).success).toBe(true);
      expect(refused.body.running).toEqual([
        {
          projectId: first,
          name: expect.stringContaining('Project '),
          state: 'building',
        },
      ]);
      expect(refused.body.detail).toBe(
        `At most 1 Previews run at the same time. Running now: ${refused.body.running[0].name}. Stop one first.`,
      );
      expect(await db().previewOperation.count({ where: { projectId: second } })).toBe(0);

      const claimed = await limitedClaim();
      await limitedHttp()
        .post(`${base}/${claimed.body.operationId}/state`)
        .set(controllerAuth)
        .send({ controllerId: CONTROLLER, state: 'succeeded' });
      expect((await limitedBuild(first)).status).toBe(202);
    });

    it('answers one 202 and one 409 for two Projects that race for the last place', async () => {
      const first = await readyProject();
      const second = await readyProject();
      expect((await limitedClaim()).status).toBe(204);

      const [one, two] = await Promise.all([limitedBuild(first), limitedBuild(second)]);

      expect([one.status, two.status].sort()).toEqual([202, 409]);
      expectProblem(one.status === 409 ? one : two, 409, 'preview-limit-reached');
      expect(await db().previewOperation.count({ where: { status: 'requested' } })).toBe(1);
    });

    it('answers 409 preview-busy for a build during a stop', async () => {
      const id = await readyProject();
      await seedRunning(id);
      expect((await limitedClaim()).status).toBe(204);
      expect(
        (
          await limitedHttp()
            .post(`${previewUrl(id)}/stop`)
            .set(limitedSession())
        ).status,
      ).toBe(202);

      expectProblem(await limitedBuild(id), 409, 'preview-busy');
    });
  });

  describe.runIf(linux)('removal on disconnect (real git)', () => {
    const repositoryStatus = async (id: string) =>
      (await http().get(`/api/projects/${id}/repository`).set('Cookie', cookie)).status;
    const listed = async () =>
      (await http().get('/api/previews').set('Cookie', cookie)).body.previews.map(
        (entry: { projectId: string }) => entry.projectId,
      ) as string[];
    const waitFor = async (done: () => Promise<boolean>, what: string) => {
      const deadline = Date.now() + 30_000;
      while (!(await done())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    it('stops the Preview and removes its data, then finishes the disconnect and forgets it', async () => {
      const id = await readyProject();
      await seedRunning(id);
      await connectController();

      const disconnect = await http().delete(`/api/projects/${id}/repository`).set(session());
      expect(disconnect.status).toBe(202);
      expect(disconnect.body.state).toBe('disconnecting');
      const removal = await db().previewOperation.findFirstOrThrow({
        where: { projectId: id, kind: 'remove_data' },
      });
      expect(removal.status).toBe('requested');
      expect(await listed()).toContain(id);

      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(await repositoryStatus(id)).toBe(200);
      expect(
        await db().previewOperation.count({ where: { projectId: id, kind: 'remove_data' } }),
      ).toBe(1);

      const claimed = await claim();
      expect(claimed.body).toMatchObject({ kind: 'remove_data', projectId: id });
      await report(claimed.body.operationId as string, { state: 'succeeded' });

      await waitFor(async () => (await repositoryStatus(id)) === 404, 'the disconnect to finish');
      expect(await db().previewOperation.count({ where: { projectId: id } })).toBe(0);
      expect(await db().previewSettings.count({ where: { projectId: id } })).toBe(0);
      expect(await listed()).not.toContain(id);
    });

    it('forgets a Preview that never ran at once', async () => {
      const id = await readyProject();

      const disconnect = await http().delete(`/api/projects/${id}/repository`).set(session());

      expect(disconnect.status).toBe(204);
      expect(await db().previewSettings.count({ where: { projectId: id } })).toBe(0);
    });

    it('stays disconnecting while the removal is not done, and asks again after it failed', async () => {
      const id = await readyProject();
      await seedRunning(id);
      await connectController();
      expect((await http().delete(`/api/projects/${id}/repository`).set(session())).status).toBe(
        202,
      );
      const claimed = await claim();
      await report(claimed.body.operationId as string, {
        state: 'failed',
        failure: { code: 'runtime_failed', detail: 'Docker could not remove resources.' },
      });

      await waitFor(
        async () =>
          (await db().previewOperation.count({ where: { projectId: id, kind: 'remove_data' } })) ===
          2,
        'the removal to be requested again',
      );
      expect(await repositoryStatus(id)).toBe(200);
    });
  });
});
