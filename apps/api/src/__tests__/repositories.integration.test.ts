import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import { createGitFixture, type GitFixture } from './git-fixture.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// Story #60, main seam: the real app over HTTP with PostgreSQL and Redis (Testcontainers) and
// the real job queue. Cases that clone need the real `git` and run on Linux only (CI runs
// them; a guard at the end fails CI if they were skipped). Fixture remotes are `file://`
// URLs, accepted only under the test-only setting this suite turns on.

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA = /^[0-9a-f]{40}$/;
const UNKNOWN_PROJECT = '00000000-0000-4000-8000-000000000000';
const PROBLEM = 'urn:agentic-studio:problem:';
const SSH_MESSAGE = 'Private repositories over SSH are not supported yet.';
const linux = process.platform === 'linux';

function expectProblem(response: request.Response, status: number, type?: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
  if (type) expect(response.body.type).toBe(`${PROBLEM}${type}`);
}

describe('repository connection API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let dataDir: string;
  let app: INestApplication;
  let cookie: string;

  const server = () => app.getHttpServer();
  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);

  async function restart(options: Parameters<typeof startStudioApp>[1] = {}) {
    await app.close();
    app = await startStudioApp(services.config, options);
    cookie = await signIn(app);
  }

  async function createProject(name: string): Promise<string> {
    const response = await request(server())
      .post('/api/projects')
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send({ name });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  const connect = (projectId: string, body: unknown) =>
    request(server())
      .post(`/api/projects/${projectId}/repository`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send(body as object);

  const getProject = (projectId: string) =>
    request(server()).get(`/api/projects/${projectId}`).set('Cookie', cookie);

  const getRepository = (projectId: string) =>
    request(server()).get(`/api/projects/${projectId}/repository`).set('Cookie', cookie);

  /** Polls the repository until it leaves `connecting`, as the web app does. */
  async function settled(projectId: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await getRepository(projectId);
      expect(response.status).toBe(200);
      if (response.body.state !== 'connecting') return response.body;
      if (Date.now() > deadline) throw new Error('the repository stayed connecting');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  beforeAll(async () => {
    services = await startStudioServices();
    dataDir = await mkdtemp(join(tmpdir(), 'studio-repo-http-'));
    services.config = { ...services.config, dataDir, gitAllowFileRemotes: true };
    app = await startStudioApp(services.config);
    cookie = await signIn(app);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Test isolation only (repositories go with their projects); assertions use the API.
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
  });

  describe('GET /api/projects/:id', () => {
    it('returns the project with no repository', async () => {
      const id = await createProject('Detail');

      const response = await getProject(id);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id,
        name: 'Detail',
        createdAt: expect.stringMatching(ISO_8601),
        repository: null,
      });
    });

    it.each([
      ['an unknown id', UNKNOWN_PROJECT],
      ['an id that is not a UUID', 'not-a-uuid'],
    ])('answers 404 problem+json for %s', async (_case, id) => {
      expectProblem(await getProject(id), 404, 'project-not-found');
    });
  });

  describe('GET /api/projects/:id/repository', () => {
    it('answers 404 when the project has no repository', async () => {
      const id = await createProject('Empty');

      expectProblem(await getRepository(id), 404, 'no-repository');
    });

    it.each([UNKNOWN_PROJECT, 'not-a-uuid'])(
      'answers 404 for the unknown project %s',
      async (id) => {
        expectProblem(await getRepository(id), 404, 'project-not-found');
      },
    );
  });

  describe('POST /api/projects/:id/repository: rejected at submit (every platform)', () => {
    it.each([
      ['an empty URL', '', 'Enter the repository URL.'],
      ['a blank URL', '   ', 'Enter the repository URL.'],
      ['a malformed URL', 'not a url', undefined],
      ['a host without a scheme', 'github.com/acme/shop', undefined],
      ['embedded credentials', 'https://user:secret@github.com/acme/shop.git', undefined],
      ['a token as user name', 'https://ghp_token@github.com/acme/shop.git', undefined],
      ['http://', 'http://github.com/acme/shop.git', undefined],
      ['git://', 'git://github.com/acme/shop.git', undefined],
      ['an absolute local path', '/srv/repos/shop.git', undefined],
      ['a relative local path', '../shop', undefined],
      ['a scp-like SSH URL', 'git@github.com:acme/shop.git', SSH_MESSAGE],
      ['an ssh:// URL', 'ssh://git@github.com/acme/shop.git', SSH_MESSAGE],
    ])('rejects %s with 422 and a field error on url', async (_case, url, message) => {
      const id = await createProject('Invalid URL');

      const response = await connect(id, { url, integrationBranch: 'dev' });

      expectProblem(response, 422);
      expect(response.body.errors).toEqual([
        { path: 'url', message: message ?? expect.any(String) },
      ]);
      expectProblem(await getRepository(id), 404, 'no-repository');
    });

    it('rejects a file:// URL when the test-only fixture-remote setting is off', async () => {
      await app.close();
      app = await startStudioApp({ ...services.config, gitAllowFileRemotes: false });
      cookie = await signIn(app);
      try {
        const id = await createProject('File URL');

        const response = await connect(id, {
          url: 'file:///srv/shop.git',
          integrationBranch: 'dev',
        });

        expectProblem(response, 422);
        expect(response.body.errors).toEqual([
          { path: 'url', message: expect.stringMatching(/^Local paths/) },
        ]);
      } finally {
        await restart();
      }
    });

    it.each(['', 'has space', '-dev', 'dev..x', 'dev.lock', 'a//b', 'x'.repeat(256)])(
      'rejects the integration branch %j with 422 and a field error',
      async (integrationBranch) => {
        const id = await createProject('Invalid branch');

        const response = await connect(id, {
          url: 'https://github.com/acme/shop.git',
          integrationBranch,
        });

        expectProblem(response, 422);
        expect(response.body.errors).toEqual([
          { path: 'integrationBranch', message: expect.any(String) },
        ]);
      },
    );

    it.each([
      ['missing fields', {}],
      ['non-string values', { url: 42, integrationBranch: true }],
    ])('rejects %s with 422 and field errors', async (_case, body) => {
      const id = await createProject('Invalid body');

      const response = await connect(id, body);

      expectProblem(response, 422);
      expect(response.body.errors.map((error: { path: string }) => error.path).sort()).toEqual([
        'integrationBranch',
        'url',
      ]);
    });

    it('answers 404 for an id that is not a UUID', async () => {
      const response = await connect('not-a-uuid', {
        url: 'https://github.com/acme/shop.git',
        integrationBranch: 'dev',
      });

      expectProblem(response, 404, 'project-not-found');
    });
  });

  describe('on an API host that is not Linux', () => {
    it('refuses to connect with 501 "Unsupported platform" and stores nothing', async () => {
      await restart({ projects: { gitSettings: { platform: 'win32' } } });
      try {
        const id = await createProject('Windows host');

        const response = await connect(id, {
          url: 'https://github.com/acme/shop.git',
          integrationBranch: 'dev',
        });

        expectProblem(response, 501, 'unsupported-platform');
        expect(response.body.title).toBe('Unsupported platform');
        expect(response.body.detail).toMatch(/Linux/);
        expectProblem(await getRepository(id), 404, 'no-repository');
      } finally {
        await restart();
      }
    });
  });

  describe('start-up reconciliation', () => {
    it('marks a repository left connecting by a crash as failed (unknown, "Interrupted")', async () => {
      const id = await createProject('Crashed');
      // Test setup only: a crash mid-clone cannot be produced through the API.
      await db().$executeRaw`
        INSERT INTO repositories (project_id, url, url_normalized, integration_branch, state)
        VALUES (${id}::uuid, 'https://github.com/acme/crashed.git', 'github.com/acme/crashed', 'dev', 'connecting')`;

      await restart();

      const response = await getRepository(id);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        state: 'failed',
        url: 'https://github.com/acme/crashed.git',
        integrationBranch: 'dev',
        failure: { code: 'unknown', detail: 'Interrupted' },
      });
      expect((await getProject(id)).body.repository).toEqual({
        state: 'failed',
        url: 'https://github.com/acme/crashed.git',
        integrationBranch: 'dev',
      });
    });
  });

  describe('authentication', () => {
    it('rejects anonymous reads and connects with 401', async () => {
      const id = await createProject('Private');
      const anonymous = request(server());

      expectProblem(await anonymous.get(`/api/projects/${id}`), 401);
      expectProblem(await request(server()).get(`/api/projects/${id}/repository`), 401);
      expectProblem(
        await request(server())
          .post(`/api/projects/${id}/repository`)
          .set('Origin', STUDIO_ORIGIN)
          .send({ url: 'https://github.com/acme/shop.git', integrationBranch: 'dev' }),
        401,
      );
      expectProblem(await getRepository(id), 404, 'no-repository');
    });

    it('rejects a connect with a foreign Origin', async () => {
      const id = await createProject('Cross-site');

      const response = await request(server())
        .post(`/api/projects/${id}/repository`)
        .set({ Origin: 'http://evil.example', Cookie: cookie })
        .send({ url: 'https://github.com/acme/shop.git', integrationBranch: 'dev' });

      expectProblem(response, 403);
      expectProblem(await getRepository(id), 404, 'no-repository');
    });
  });

  describe.runIf(linux)('with the real git (Linux)', () => {
    let fixtures: string;
    let fixture: GitFixture;

    beforeAll(async () => {
      fixtures = await mkdtemp(join(tmpdir(), 'studio-repo-fixtures-'));
      fixture = createGitFixture(fixtures, 'shop');
    });

    afterAll(async () => {
      if (fixtures) await rm(fixtures, { recursive: true, force: true });
    });

    it('connects: 201 connecting at once, then ready with the commit, also after a restart', async () => {
      const id = await createProject('Shop');

      const response = await connect(id, { url: `  ${fixture.url}  `, integrationBranch: ' dev ' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        state: 'connecting',
        url: fixture.url,
        integrationBranch: 'dev',
      });
      const ready = await settled(id);
      expect(ready).toEqual({
        state: 'ready',
        url: fixture.url,
        integrationBranch: 'dev',
        headSha: fixture.commits.dev,
        lastFetchedAt: expect.stringMatching(ISO_8601),
      });
      expect(ready.headSha).toMatch(SHA);
      expect((await getProject(id)).body.repository).toEqual({
        state: 'ready',
        url: fixture.url,
        integrationBranch: 'dev',
      });

      await restart();
      expect((await getRepository(id)).body).toEqual(ready);
    });

    it('refuses a second connect to the same project with 409', async () => {
      const id = await createProject('Twice');
      expect((await connect(id, { url: fixture.url, integrationBranch: 'dev' })).status).toBe(201);
      await settled(id);

      const response = await connect(id, { url: fixture.url, integrationBranch: 'main' });

      expectProblem(response, 409, 'repository-already-connected');
      expect((await getRepository(id)).body.integrationBranch).toBe('dev');
    });

    it('lets the store decide between concurrent connects: one 201, one 409', async () => {
      const id = await createProject('Race');

      const responses = await Promise.all([
        connect(id, { url: fixture.url, integrationBranch: 'dev' }),
        connect(id, { url: fixture.url, integrationBranch: 'main' }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expect((await settled(id)).state).toBe('ready');
    });

    it.each([
      ['the same URL', (url: string) => url],
      ['a trailing slash', (url: string) => `${url}/`],
      ['no .git', (url: string) => url.replace(/\.git$/, '')],
      ['no .git and a trailing slash', (url: string) => url.replace(/\.git$/, '/')],
    ])(
      'refuses a fixture remote already connected to another project (%s)',
      async (_form, form) => {
        const first = await createProject('First owner');
        expect((await connect(first, { url: fixture.url, integrationBranch: 'dev' })).status).toBe(
          201,
        );
        const second = await createProject('Second');

        const response = await connect(second, {
          url: form(fixture.url),
          integrationBranch: 'dev',
        });

        expectProblem(response, 409, 'remote-already-connected');
        expect(response.body.errors).toEqual([
          { path: 'url', message: 'Already connected to First owner' },
        ]);
        expectProblem(await getRepository(second), 404, 'no-repository');
        await settled(first);
      },
    );

    it.each([
      'https://github.com/acme/shop',
      'https://GITHUB.com/acme/shop.git',
      'https://github.com/acme/shop/',
      'https://github.com/acme/shop.git/',
      'https://github.com:443/acme/shop.git',
    ])('refuses %s when another project holds that remote in another form', async (url) => {
      const owner = await createProject('Acme Shop');
      // Test setup only: the owner connected the same remote over SSH (scp-like form), which
      // this story cannot do through the API yet.
      await db().$executeRaw`
        INSERT INTO repositories (project_id, url, url_normalized, integration_branch, state, failure_code, failure_detail)
        VALUES (${owner}::uuid, 'git@github.com:acme/shop.git', 'github.com/acme/shop', 'dev', 'failed', 'unknown', '')`;
      const id = await createProject('Copycat');

      const response = await connect(id, { url, integrationBranch: 'dev' });

      expectProblem(response, 409, 'remote-already-connected');
      expect(response.body.detail).toBe('Already connected to Acme Shop');
      expect(response.body.errors).toEqual([
        { path: 'url', message: 'Already connected to Acme Shop' },
      ]);
    });

    it('fails with branch_not_found naming the default branch, then Retry with another branch connects', async () => {
      const id = await createProject('Wrong branch');
      expect((await connect(id, { url: fixture.url, integrationBranch: 'release' })).status).toBe(
        201,
      );

      const failed = await settled(id);

      expect(failed).toEqual({
        state: 'failed',
        url: fixture.url,
        integrationBranch: 'release',
        failure: {
          code: 'branch_not_found',
          detail: expect.any(String),
          remoteDefaultBranch: 'main',
        },
      });

      const retry = await connect(id, { url: fixture.url, integrationBranch: 'main' });
      expect(retry.status).toBe(201);
      expect(retry.body).toEqual({
        state: 'connecting',
        url: fixture.url,
        integrationBranch: 'main',
      });
      expect(await settled(id)).toMatchObject({ state: 'ready', headSha: fixture.commits.main });
    });

    it('fails with repository_not_found for a missing repository', async () => {
      const id = await createProject('Missing');
      const url = fixture.url.replace(/shop\.git$/, 'missing.git');
      expect((await connect(id, { url, integrationBranch: 'dev' })).status).toBe(201);

      const failed = await settled(id);

      expect(failed.failure).toEqual({ code: 'repository_not_found', detail: expect.any(String) });
      // Redacted: the local path of the fixture is not in the detail.
      expect(failed.failure.detail).not.toContain(fixtures);
    });

    it('fails with host_unreachable when nothing listens', async () => {
      const id = await createProject('Unreachable');
      const url = 'https://127.0.0.1:1/acme/shop.git';
      expect((await connect(id, { url, integrationBranch: 'dev' })).status).toBe(201);

      expect((await settled(id)).failure).toEqual({
        code: 'host_unreachable',
        detail: expect.any(String),
      });
    });

    describe('with test limits', () => {
      let silent: Server;
      let silentPort: number;
      const sockets = new Set<Socket>();

      beforeAll(async () => {
        // Accepts connections and never answers: the remote hangs.
        silent = createServer((socket) => {
          sockets.add(socket);
          socket.on('close', () => sockets.delete(socket));
        });
        await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
        silentPort = (silent.address() as { port: number }).port;
      });

      afterAll(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => silent.close(resolve));
        await restart();
      });

      it('fails with timeout when the remote does not answer in time', async () => {
        await restart({
          projects: { gitSettings: { fetchTimeoutMs: 1_500, cloneTimeoutMs: 1_500 } },
        });
        const id = await createProject('Slow');
        const url = `https://127.0.0.1:${silentPort}/acme/shop.git`;
        expect((await connect(id, { url, integrationBranch: 'dev' })).status).toBe(201);

        expect((await settled(id)).failure).toEqual({
          code: 'timeout',
          detail: expect.any(String),
        });
      });

      it('fails with size_limit when the Clone grows past the limit', async () => {
        await restart({
          projects: { gitSettings: { maxCloneBytes: 256 * 1024, sizePollIntervalMs: 20 } },
        });
        const big = createGitFixture(fixtures, 'big', { bigFileBytes: 4 * 1024 * 1024 });
        const id = await createProject('Big');
        expect((await connect(id, { url: big.url, integrationBranch: 'dev' })).status).toBe(201);

        expect((await settled(id)).failure).toEqual({
          code: 'size_limit',
          detail: expect.any(String),
        });
      });
    });
  });

  // Guard against a silent skip: in CI the Linux-only cases above must run.
  it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs the real-git cases in CI (Linux)', () => {
    expect(process.platform).toBe('linux');
  });
});
