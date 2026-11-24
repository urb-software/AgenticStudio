import { spawnSync } from 'node:child_process';
import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import { SECRET_STORE, type SecretStore } from '../platform/secrets/index.js';
import { createGitFixture, type GitFixture, pushFiles } from './git-fixture.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// The environment controller routes on the real app (PostgreSQL and Redis via Testcontainers).
// No route creates an operation yet, so the tests insert the row with SQL. The archive cases need
// the real `git` and run on Linux only.

// Throwaway tokens generated per run; none is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const CONTROLLER_TOKEN = randomBytes(32).toString('base64');
const digest = (token: string) => createSecretKey(createHash('sha256').update(token).digest());
const PROBLEM = 'urn:agentic-studio:problem:';
const CONTROLLER = randomUUID();
const OTHER_CONTROLLER = randomUUID();
const ENVIRONMENT_VALUE = 'hunter2-only-for-this-test';
const linux = process.platform === 'linux';
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n';
const LOG_CAP_BYTES = 200;

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const controllerAuth = bearer(CONTROLLER_TOKEN);

function expectProblem(response: request.Response, status: number, type?: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
  if (type) expect(response.body.type).toBe(`${PROBLEM}${type}`);
}

/** A tar stays a buffer; a problem answer is parsed as JSON. */
function binary(
  response: request.Response,
  callback: (error: Error | null, body: Buffer | object) => void,
) {
  const stream = response as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.on('end', () => {
    const body = Buffer.concat(chunks);
    const type = String(response.headers['content-type'] ?? '');
    callback(null, type.includes('json') ? (JSON.parse(body.toString('utf8')) as object) : body);
  });
}

/** Polls until the check holds: the archive is removed once the response has been sent. */
async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe('Environment controller API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let dataDir: string;
  let app: INestApplication;
  let cookie: string;
  let fixture: GitFixture | undefined;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const snapshots = () =>
    app.get<SecretStore>(SECRET_STORE).listOlderThan('environments.preview-environment-file', 0);
  const http = () => request(app.getHttpServer());
  const base = '/api/controller/operations';
  const claim = (controllerId = CONTROLLER) =>
    http().post(`${base}/claim`).set(controllerAuth).send({ controllerId });
  const state = (id: string, body: object) =>
    http().post(`${base}/${id}/state`).set(controllerAuth).send(body);
  const log = (id: string, body: object) =>
    http().post(`${base}/${id}/log`).set(controllerAuth).send(body);
  const source = (id: string, controllerId = CONTROLLER) =>
    http()
      .get(`${base}/${id}/source`)
      .query({ controllerId })
      .set(controllerAuth)
      .buffer(true)
      .parse(binary);

  async function createProject(): Promise<string> {
    const response = await http()
      .post('/api/projects')
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send({ name: `Project ${randomUUID()}` });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  async function insertBuild(projectId: string, commit = 'a'.repeat(40)): Promise<string> {
    const row = await db().previewOperation.create({
      data: {
        projectId,
        kind: 'build',
        status: 'requested',
        commit,
        composeFile: 'compose.yaml',
        service: 'web',
        port: 3000,
        memoryMiB: 1024,
        cpuPercent: 100,
        tasksMax: 512,
        buildMinutes: 20,
      },
    });
    return row.id;
  }

  async function insertOther(projectId: string, kind: 'stop' | 'remove_data' | 'state') {
    const row = await db().previewOperation.create({
      data: { projectId, kind, status: 'requested' },
    });
    return row.id;
  }

  async function setEnvironmentFile(projectId: string) {
    const response = await http()
      .put(`/api/projects/${projectId}/environment-file`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send({ path: '.env', content: `DB_PASSWORD=${ENVIRONMENT_VALUE}\n` });
    expect(response.status).toBe(200);
  }

  const line = (seq: number, text: string, stream = 'build') => ({
    seq,
    at: '2026-11-24T10:00:00.000Z',
    stream,
    text,
  });

  beforeAll(async () => {
    services = await startStudioServices();
    dataDir = await mkdtemp(join(tmpdir(), 'studio-controller-http-'));
    services.config = {
      ...services.config,
      dataDir,
      gitAllowFileRemotes: true,
      gitAllowPrivateRemotes: true,
      workerToken: digest(WORKER_TOKEN),
      controllerToken: digest(CONTROLLER_TOKEN),
      controllerLeaseSeconds: 60,
      previewLogMaxBytes: LOG_CAP_BYTES,
    };
    if (linux) {
      fixture = createGitFixture(dataDir, 'controller-source', { branches: ['main', 'dev'] });
      pushFiles(fixture, 'dev', fixture.commits.dev!, {
        'compose.yaml': COMPOSE,
        'src/app.js': 'console.log(1);\n',
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
    for (const reference of await snapshots()) {
      await app.get<SecretStore>(SECRET_STORE).delete(reference);
    }
  });

  describe('the three credentials open three sets of routes', () => {
    const bodies: [string, string, object][] = [
      ['POST', `${base}/claim`, { controllerId: CONTROLLER }],
      ['POST', `${base}/${randomUUID()}/state`, { controllerId: CONTROLLER, state: 'in_progress' }],
      ['POST', `${base}/${randomUUID()}/log`, { controllerId: CONTROLLER, lines: [] }],
    ];

    it('refuses every controller route to the worker token, a session and no credential', async () => {
      for (const [, path, body] of bodies) {
        expectProblem(await http().post(path).send(body), 401);
        expectProblem(await http().post(path).set(bearer(WORKER_TOKEN)).send(body), 401);
        expectProblem(
          await http().post(path).set({ Origin: STUDIO_ORIGIN, Cookie: cookie }).send(body),
          401,
        );
      }
      const source = `${base}/${randomUUID()}/source?controllerId=${CONTROLLER}`;
      expectProblem(await http().get(source), 401);
      expectProblem(await http().get(source).set(bearer(WORKER_TOKEN)), 401);
      expectProblem(await http().get(source).set('Cookie', cookie), 401);
    });

    it('refuses the controller token on every worker route', async () => {
      for (const path of [
        '/api/worker/runs/claim',
        '/api/worker/lookups/claim',
        '/api/worker/status',
      ]) {
        expectProblem(await http().post(path).set(controllerAuth).send({}), 401);
      }
    });

    it('refuses the controller token on operator routes', async () => {
      expectProblem(await http().get('/api/projects').set(controllerAuth), 401);
      expectProblem(await http().get('/api/runs').set(controllerAuth), 401);
      expectProblem(await http().get('/api/auth/session').set(controllerAuth), 401);
      const created = await http().post('/api/projects').set(controllerAuth).send({ name: 'Nope' });
      expect([401, 403]).toContain(created.status);
    });

    it('answers 401 on every controller route while no controller token is configured', async () => {
      const closed = await startStudioApp({ ...services.config, controllerToken: null });
      try {
        const server = closed.getHttpServer();
        for (const [, path, body] of bodies) {
          expectProblem(await request(server).post(path).set(controllerAuth).send(body), 401);
        }
        expectProblem(
          await request(server)
            .get(`${base}/${randomUUID()}/source`)
            .query({ controllerId: CONTROLLER })
            .set(controllerAuth),
          401,
        );
      } finally {
        await closed.close();
      }
    });

    it('does not need the Studio origin on a controller route', async () => {
      const response = await claim();
      expect(response.status).toBe(204);
    });
  });

  describe('POST /api/controller/operations/claim', () => {
    it('answers 204 when there is nothing to do', async () => {
      const response = await claim();
      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
    });

    it('answers 422 for a body that is not a controller id', async () => {
      expectProblem(await http().post(`${base}/claim`).set(controllerAuth).send({}), 422);
      expectProblem(
        await http().post(`${base}/claim`).set(controllerAuth).send({ controllerId: 'x' }),
        422,
      );
      expectProblem(
        await http()
          .post(`${base}/claim`)
          .set(controllerAuth)
          .send({ controllerId: CONTROLLER, extra: true }),
        422,
      );
    });

    it('hands out a build with its limits and the Environment file, to the holder only', async () => {
      const projectId = await createProject();
      await setEnvironmentFile(projectId);
      const id = await insertBuild(projectId);

      const response = await claim();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        operationId: id,
        projectId,
        composeProject: `preview-${projectId.replaceAll('-', '')}`,
        previewLabel: `preview-${projectId.replaceAll('-', '').slice(0, 12)}`,
        kind: 'build',
        commit: 'a'.repeat(40),
        composeFile: 'compose.yaml',
        service: 'web',
        port: 3000,
        environmentFile: { path: '.env', content: `DB_PASSWORD=${ENVIRONMENT_VALUE}\n` },
        limits: { memoryMiB: 1024, cpuPercent: 100, tasksMax: 512, buildMinutes: 20 },
      });
      const held = await db().previewOperation.findUniqueOrThrow({ where: { id } });
      expect(held).toMatchObject({ status: 'claimed', claimedBy: CONTROLLER });
    });

    it('stores no Environment file value in the operation, and answers null without a file', async () => {
      const projectId = await createProject();
      await setEnvironmentFile(projectId);
      const id = await insertBuild(projectId);
      await claim();

      const row = await db().previewOperation.findUniqueOrThrow({ where: { id } });

      expect(JSON.stringify(row)).not.toContain(ENVIRONMENT_VALUE);
      expect(await snapshots()).toEqual([row.environmentFileSecretId]);
      expect(row.environmentFileSecretId).not.toBeNull();

      const other = await createProject();
      await insertBuild(other);
      const second = await claim();
      expect(second.body.environmentFile).toBeNull();
    });

    it('hands out stop, remove_data and state with no build data', async () => {
      const projectId = await createProject();
      const id = await insertOther(projectId, 'remove_data');

      const response = await claim();

      expect(response.body).toEqual({
        operationId: id,
        projectId,
        composeProject: `preview-${projectId.replaceAll('-', '')}`,
        previewLabel: `preview-${projectId.replaceAll('-', '').slice(0, 12)}`,
        kind: 'remove_data',
      });
    });

    it('hands out the oldest operation first, and one claimed operation per Project', async () => {
      const first = await createProject();
      const second = await createProject();
      const oldest = await insertBuild(first);
      const sameProject = await insertOther(first, 'stop');
      const other = await insertBuild(second);

      expect((await claim()).body.operationId).toBe(oldest);
      expect((await claim()).body.operationId).toBe(other);
      expect((await claim()).status).toBe(204);
      expect(
        await db().previewOperation.findUniqueOrThrow({ where: { id: sameProject } }),
      ).toMatchObject({ status: 'requested' });
    });

    it('never hands one operation to two simultaneous claims', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 5; i += 1) await insertBuild(await createProject());

      const responses = await Promise.all(Array.from({ length: 8 }, () => claim(randomUUID())));

      for (const response of responses) {
        if (response.status === 200) ids.add(response.body.operationId as string);
      }
      expect(responses.filter((response) => response.status === 200)).toHaveLength(5);
      expect(ids.size).toBe(5);
    });

    it('fails an operation whose controller stopped reporting, drops its snapshot and never hands it out again', async () => {
      const projectId = await createProject();
      await setEnvironmentFile(projectId);
      const lost = await insertBuild(projectId);
      await claim();
      await db().previewOperation.update({
        where: { id: lost },
        data: { heartbeatAt: new Date(Date.now() - 120_000) },
      });
      const next = await insertOther(projectId, 'state');

      const response = await claim(OTHER_CONTROLLER);

      expect(response.body.operationId).toBe(next);
      const failed = await db().previewOperation.findUniqueOrThrow({ where: { id: lost } });
      expect(failed).toMatchObject({
        status: 'failed',
        failureCode: 'controller_lost',
        environmentFileSecretId: null,
      });
      expect(failed.claimedBy).toBe(CONTROLLER);
      expect(await snapshots()).toEqual([]);
      expect((await state(lost, { controllerId: CONTROLLER, state: 'in_progress' })).status).toBe(
        409,
      );
    });
  });

  describe('POST /api/controller/operations/:id/state', () => {
    async function claimed(): Promise<string> {
      const id = await insertBuild(await createProject());
      expect((await claim()).status).toBe(200);
      return id;
    }

    it('renews the lease, then succeeds with what is running, then refuses a further report', async () => {
      const id = await claimed();
      await db().previewOperation.update({
        where: { id },
        data: { heartbeatAt: new Date(Date.now() - 30_000) },
      });

      expect((await state(id, { controllerId: CONTROLLER, state: 'in_progress' })).status).toBe(
        204,
      );
      const renewed = await db().previewOperation.findUniqueOrThrow({ where: { id } });
      expect(Date.now() - renewed.heartbeatAt!.getTime()).toBeLessThan(10_000);

      expect(
        (
          await state(id, {
            controllerId: CONTROLLER,
            state: 'succeeded',
            runtime: { services: [{ name: 'web', state: 'running' }] },
          })
        ).status,
      ).toBe(204);
      const done = await db().previewOperation.findUniqueOrThrow({ where: { id } });
      expect(done).toMatchObject({ status: 'succeeded', claimedBy: CONTROLLER });
      expect(done.result).toEqual({ services: [{ name: 'web', state: 'running' }] });
      expectProblem(
        await state(id, { controllerId: CONTROLLER, state: 'in_progress' }),
        409,
        'preview-operation-not-held',
      );
    });

    it('fails with the code and refusals, redacting the Environment file values', async () => {
      const projectId = await createProject();
      await setEnvironmentFile(projectId);
      const id = await insertBuild(projectId);
      await claim();

      const response = await state(id, {
        controllerId: CONTROLLER,
        state: 'failed',
        failure: {
          code: 'validation_refused',
          detail: `refused near ${ENVIRONMENT_VALUE}`,
          refusals: [
            { code: 'privileged', place: 'services.web', message: 'Privileged is refused.' },
          ],
        },
      });

      expect(response.status).toBe(204);
      const failed = await db().previewOperation.findUniqueOrThrow({ where: { id } });
      expect(failed.failureCode).toBe('validation_refused');
      expect(failed.failureDetail).not.toContain(ENVIRONMENT_VALUE);
      expect(failed.refusals).toEqual([
        { code: 'privileged', place: 'services.web', message: 'Privileged is refused.' },
      ]);
      expect(failed.environmentFileSecretId).toBeNull();
    });

    it('answers 404 for an unknown operation and for an id that is not a UUID', async () => {
      const body = { controllerId: CONTROLLER, state: 'in_progress' };
      expectProblem(await state(randomUUID(), body), 404, 'preview-operation-not-found');
      expectProblem(await state('not-a-uuid', body), 404, 'preview-operation-not-found');
    });

    it('answers 409 to a controller that does not hold the operation', async () => {
      const id = await claimed();

      expectProblem(
        await state(id, { controllerId: OTHER_CONTROLLER, state: 'in_progress' }),
        409,
        'preview-operation-not-held',
      );
    });

    it.each([
      [
        'a failure without a failed state',
        { state: 'succeeded', failure: { code: 'build_failed', detail: 'x' } },
      ],
      ['failed without a failure', { state: 'failed' }],
      [
        'controller_lost from the controller',
        { state: 'failed', failure: { code: 'controller_lost', detail: 'x' } },
      ],
      ['an unknown state', { state: 'done' }],
    ])('answers 422 for %s', async (_case, body) => {
      const id = await claimed();
      expectProblem(await state(id, { controllerId: CONTROLLER, ...body }), 422);
    });
  });

  describe('POST /api/controller/operations/:id/log', () => {
    async function claimed(): Promise<string> {
      const projectId = await createProject();
      await setEnvironmentFile(projectId);
      const id = await insertBuild(projectId);
      expect((await claim()).status).toBe(200);
      return id;
    }

    it('stores the lines redacted and says how many', async () => {
      const id = await claimed();

      const response = await log(id, {
        controllerId: CONTROLLER,
        lines: [
          line(1, 'step 1/3'),
          line(2, `DB_PASSWORD=${ENVIRONMENT_VALUE}`, 'start'),
          line(3, 'Authorization: Bearer abc.def-123'),
        ],
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ stored: 3, truncated: false });
      const stored = await db().previewOperationLine.findMany({
        where: { operationId: id },
        orderBy: { seq: 'asc' },
      });
      expect(stored.map((row) => row.stream)).toEqual(['build', 'start', 'build']);
      const text = stored.map((row) => row.text).join('\n');
      expect(text).toContain('step 1/3');
      expect(text).not.toContain(ENVIRONMENT_VALUE);
      expect(text).not.toContain('abc.def-123');
    });

    it('accepts a legal batch of control characters, whose JSON escaping passes 100 KiB', async () => {
      const id = await claimed();
      const control = '\u0001'.repeat(2048);
      const lines = Array.from({ length: 32 }, (_, index) => line(index + 1, control));
      expect(JSON.stringify({ controllerId: CONTROLLER, lines }).length).toBeGreaterThan(
        300 * 1024,
      );

      const response = await log(id, { controllerId: CONTROLLER, lines });

      expect(response.status).toBe(200);
      const other = await http()
        .post(`${base}/${id}/log`)
        .set(bearer(WORKER_TOKEN))
        .send({ controllerId: CONTROLLER, lines });
      expect(other.status).toBe(413);
    });

    it('ignores a re-sent seq, so the same batch twice stores it once', async () => {
      const id = await claimed();
      const batch = { controllerId: CONTROLLER, lines: [line(1, 'one'), line(2, 'two')] };

      expect((await log(id, batch)).body).toEqual({ stored: 2, truncated: false });
      expect((await log(id, batch)).body).toEqual({ stored: 0, truncated: false });
      expect(await db().previewOperationLine.count({ where: { operationId: id } })).toBe(2);
    });

    it('stores one notice at the cap, drops later lines and says truncated', async () => {
      const id = await claimed();

      const first = await log(id, {
        controllerId: CONTROLLER,
        lines: [line(1, 'x'.repeat(150)), line(2, 'y'.repeat(150)), line(3, 'z')],
      });
      expect(first.body).toEqual({ stored: 2, truncated: true });
      const later = await log(id, { controllerId: CONTROLLER, lines: [line(4, 'later')] });
      expect(later.body).toEqual({ stored: 0, truncated: true });

      const stored = await db().previewOperationLine.findMany({
        where: { operationId: id },
        orderBy: { seq: 'asc' },
      });
      expect(stored.map((row) => row.seq)).toEqual([1, 2]);
      expect(stored[1]!.text).toContain('log truncated');
      const row = await db().previewOperation.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ logTruncated: true, logBytes: 150 });
    });

    it('answers 404, 409 and 422', async () => {
      const id = await claimed();
      const lines = [line(1, 'x')];

      expectProblem(
        await log(randomUUID(), { controllerId: CONTROLLER, lines }),
        404,
        'preview-operation-not-found',
      );
      expectProblem(
        await log(id, { controllerId: OTHER_CONTROLLER, lines }),
        409,
        'preview-operation-not-held',
      );
      expectProblem(await log(id, { controllerId: CONTROLLER, lines: [] }), 422);
      expectProblem(
        await log(id, { controllerId: CONTROLLER, lines: [line(2, 'a'), line(2, 'b')] }),
        422,
      );
      expectProblem(
        await log(id, {
          controllerId: CONTROLLER,
          lines: [line(1, 'x'.repeat(2049))],
        }),
        422,
      );
    });
  });

  describe.runIf(linux)('GET /api/controller/operations/:id/source', () => {
    const archiveFolder = () => join(dataDir, 'tmp', 'preview-archives');
    const leftOver = async () =>
      existsSync(archiveFolder()) ? await readdir(archiveFolder()) : [];

    async function readyProject(from: GitFixture = fixture!): Promise<string> {
      const projectId = await createProject();
      const connected = await http()
        .post(`/api/projects/${projectId}/repository`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
        .send({ url: from.url, integrationBranch: 'dev' });
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

    function entriesOf(tar: Buffer): string[] {
      return spawnSync('tar', ['-t'], { input: tar, encoding: 'utf8' })
        .stdout.split('\n')
        .filter((entry) => entry !== '')
        .map((entry) => entry.replace(/\/$/, ''))
        .sort();
    }

    it('streams the tracked tree of the build commit with its length, and removes the temporary file', async () => {
      const projectId = await readyProject();
      const commit = fixture!.commits.dev!;
      const head = spawnSync('git', ['--git-dir', fixture!.bare, 'rev-parse', 'dev'], {
        encoding: 'utf8',
      }).stdout.trim();
      const id = await insertBuild(projectId, head);
      await claim();

      const response = await source(id);

      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/x-tar');
      const body = response.body as Buffer;
      expect(Number(response.headers['content-length'])).toBe(body.length);
      const tracked = spawnSync(
        'git',
        ['--git-dir', fixture!.bare, 'ls-tree', '-r', '-t', '--name-only', head],
        { encoding: 'utf8' },
      )
        .stdout.split('\n')
        .filter((entry) => entry !== '')
        .sort();
      expect(entriesOf(body)).toEqual(tracked);
      expect(tracked).toContain('compose.yaml');
      expect(await eventually(async () => (await leftOver()).length === 0)).toBe(true);
    });

    it('answers 409 source-unavailable for a commit the Clone lacks, leaving no file', async () => {
      const projectId = await readyProject();
      const id = await insertBuild(projectId, 'f'.repeat(40));
      await claim();

      expectProblem(await source(id), 409, 'preview-operation-source-unavailable');
      expect(await leftOver()).toEqual([]);
    });

    it('answers 409 to a controller that does not hold the build and for an operation that is not a build', async () => {
      const projectId = await readyProject();
      const build = await insertBuild(projectId, fixture!.commits.dev!);
      await claim();
      expectProblem(await source(build, OTHER_CONTROLLER), 409, 'preview-operation-not-held');
      await state(build, { controllerId: CONTROLLER, state: 'succeeded' });
      expectProblem(await source(build), 409, 'preview-operation-not-held');

      const stop = await insertOther(projectId, 'stop');
      await claim();
      expectProblem(await source(stop), 409, 'preview-operation-not-a-build');
    });

    it('serves each build the tree of its own Project at its own commit, and no other controller its source', async () => {
      const other = createGitFixture(dataDir, 'controller-source-b', { branches: ['main', 'dev'] });
      pushFiles(other, 'dev', other.commits.dev!, { 'only-in-b.txt': 'b\n' });
      const projectA = await readyProject();
      const projectB = await readyProject(other);
      const headOf = (from: GitFixture) =>
        spawnSync('git', ['--git-dir', from.bare, 'rev-parse', 'dev'], {
          encoding: 'utf8',
        }).stdout.trim();
      const treeOf = (from: GitFixture, commit: string) =>
        spawnSync('git', ['--git-dir', from.bare, 'ls-tree', '-r', '-t', '--name-only', commit], {
          encoding: 'utf8',
        })
          .stdout.split('\n')
          .filter((entry) => entry !== '')
          .sort();
      const buildA = await insertBuild(projectA, headOf(fixture!));
      const buildB = await insertBuild(projectB, headOf(other));
      expect((await claim(CONTROLLER)).body.operationId).toBe(buildA);
      expect((await claim(OTHER_CONTROLLER)).body.operationId).toBe(buildB);

      const sourceA = entriesOf((await source(buildA, CONTROLLER)).body as Buffer);
      const sourceB = entriesOf((await source(buildB, OTHER_CONTROLLER)).body as Buffer);

      expect(sourceA).toEqual(treeOf(fixture!, headOf(fixture!)));
      expect(sourceA).not.toContain('only-in-b.txt');
      expect(sourceB).toEqual(treeOf(other, headOf(other)));
      expect(sourceB).toContain('only-in-b.txt');
      expectProblem(await source(buildB, CONTROLLER), 409, 'preview-operation-not-held');
      expectProblem(await source(buildA, OTHER_CONTROLLER), 409, 'preview-operation-not-held');
    });

    it('takes no Project or commit in the source request', async () => {
      const projectId = await readyProject();
      const build = await insertBuild(projectId, fixture!.commits.dev!);
      await claim();

      for (const extra of [{ projectId }, { commit: 'f'.repeat(40) }]) {
        expectProblem(
          await http()
            .get(`${base}/${build}/source`)
            .query({ controllerId: CONTROLLER, ...extra })
            .set(controllerAuth),
          422,
        );
      }
    });

    it('answers 404 for an unknown operation and 422 without a controller id', async () => {
      expectProblem(await source(randomUUID()), 404, 'preview-operation-not-found');
      expectProblem(await http().get(`${base}/${randomUUID()}/source`).set(controllerAuth), 422);
    });
  });
});
