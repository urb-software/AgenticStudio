import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import { QUEUE_KEY_PREFIX } from '../platform/queue/bullmq-job-queues.js';
import {
  createGitFixture,
  deleteRemoteBranch,
  type GitFixture,
  pushCommit,
  restoreRemoteBranch,
} from './git-fixture.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// Stories #60 (connect), #61 (fetch) and #63 (disconnect), main seam (SSH, #62, in
// ssh-repositories.integration.test.ts): the real app over HTTP with PostgreSQL and Redis (Testcontainers) and
// the real job queue. Cases that clone need the real `git` and run on Linux only (CI runs
// them; a guard at the end fails CI if they were skipped). Fixture remotes are `file://`
// URLs, accepted only under the test-only setting this suite turns on.

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA = /^[0-9a-f]{40}$/;
const UNKNOWN_PROJECT = '00000000-0000-4000-8000-000000000000';
const PROBLEM = 'urn:agentic-studio:problem:';
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

  const fetchRepository = (projectId: string) =>
    request(server())
      .post(`/api/projects/${projectId}/repository/fetch`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie });

  const verify = (projectId: string, body: object = {}) =>
    request(server())
      .post(`/api/projects/${projectId}/repository/verify`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send(body);

  /**
   * Test setup only: an SSH Repository awaiting its key, without a real Deploy key (the
   * secret reference points nowhere; these tests never reach Git).
   */
  async function insertAwaitingKey(projectId: string, name: string) {
    await db().$executeRaw`
      INSERT INTO repositories (project_id, url, url_normalized, integration_branch, state, deploy_key_secret_id, public_key)
      VALUES (${projectId}::uuid, ${`git@github.com:acme/${name}.git`}, ${`github.com/acme/${name}`}, 'dev',
              'awaiting_key', gen_random_uuid(), 'placeholder public key')`;
  }

  const disconnect = (projectId: string) =>
    request(server())
      .delete(`/api/projects/${projectId}/repository`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie });

  /** Polls the repository until it leaves `connecting` and `fetching`, as the web app does. */
  async function settled(projectId: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await getRepository(projectId);
      expect(response.status).toBe(200);
      if (!['connecting', 'fetching'].includes(response.body.state)) return response.body;
      if (Date.now() > deadline) throw new Error(`the repository stayed ${response.body.state}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  beforeAll(async () => {
    services = await startStudioServices();
    dataDir = await mkdtemp(join(tmpdir(), 'studio-repo-http-'));
    // The fixtures (silent servers, closed ports) are on 127.0.0.1: an explicit opt-in (Issue #69).
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

  describe('the remote address policy at its production default (Issue #69)', () => {
    beforeAll(async () => {
      await app.close();
      app = await startStudioApp({ ...services.config, gitAllowPrivateRemotes: false });
      cookie = await signIn(app);
    });

    afterAll(() => restart());

    it.each([
      ['https://169.254.169.254/latest/meta-data.git', /never connects to link-local/],
      ['https://[fe80::1]/acme/shop.git', /never connects to link-local/],
      ['https://127.0.0.1/acme/shop.git', /STUDIO_GIT_ALLOW_PRIVATE_REMOTES=true/],
      ['https://0x7f.1/acme/shop.git', /STUDIO_GIT_ALLOW_PRIVATE_REMOTES=true/],
      ['git@10.0.0.5:acme/shop.git', /STUDIO_GIT_ALLOW_PRIVATE_REMOTES=true/],
    ])('rejects the IP-literal URL %s with 422 and a field error on url', async (url, message) => {
      const id = await createProject('Address policy');

      const response = await connect(id, { url, integrationBranch: 'dev' });

      expectProblem(response, 422);
      expect(response.body.errors).toEqual([
        { path: 'url', message: expect.stringMatching(/^This address is not allowed: /) },
      ]);
      expect(response.body.errors[0].message).toMatch(message);
      expectProblem(await getRepository(id), 404, 'no-repository');
    });

    it.runIf(linux)(
      'fails the clone with remote_not_allowed when the host name resolves to loopback',
      async () => {
        const id = await createProject('Loopback name');
        const url = 'https://localhost:1/acme/shop.git';
        expect((await connect(id, { url, integrationBranch: 'dev' })).status).toBe(201);

        const failed = await settled(id);

        expect(failed.state).toBe('failed');
        expect(failed.failure).toEqual({
          code: 'remote_not_allowed',
          detail: expect.stringMatching(
            /^localhost resolves to (127\.0\.0\.1|::1), a loopback or private address\. .*STUDIO_GIT_ALLOW_PRIVATE_REMOTES=true/,
          ),
        });
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
      ['a git+ssh:// URL', 'git+ssh://git@github.com/acme/shop.git', undefined],
      ['an SSH URL with a password', 'ssh://git:secret@github.com/acme/shop.git', undefined],
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

    it('refuses to connect over SSH with the same 501 and stores nothing', async () => {
      await restart({ projects: { gitSettings: { platform: 'win32' } } });
      try {
        const id = await createProject('Windows SSH');

        const response = await connect(id, {
          url: 'git@github.com:acme/shop.git',
          integrationBranch: 'dev',
        });

        expectProblem(response, 501, 'unsupported-platform');
        expectProblem(await getRepository(id), 404, 'no-repository');
      } finally {
        await restart();
      }
    });

    it('refuses to verify with 501 and leaves the repository as it was', async () => {
      await restart({ projects: { gitSettings: { platform: 'win32' } } });
      try {
        const id = await createProject('Windows verify');
        await insertAwaitingKey(id, 'win-v');

        expectProblem(await verify(id), 501, 'unsupported-platform');
        expect((await getRepository(id)).body.state).toBe('awaiting_key');
      } finally {
        await restart();
      }
    });

    it('refuses to disconnect with 501 and leaves the repository as it was', async () => {
      await restart({ projects: { gitSettings: { platform: 'win32' } } });
      try {
        const id = await createProject('Windows disconnect');
        // Test setup only: a ready repository cannot be connected on this host.
        await db().$executeRaw`
          INSERT INTO repositories (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
          VALUES (${id}::uuid, 'https://github.com/acme/win-d.git', 'github.com/acme/win-d', 'dev', 'ready', ${'d'.repeat(40)}, now())`;

        expectProblem(await disconnect(id), 501, 'unsupported-platform');
        expect((await getRepository(id)).body.state).toBe('ready');
      } finally {
        await restart();
      }
    });

    it('refuses to fetch with 501 and leaves the repository as it was', async () => {
      await restart({ projects: { gitSettings: { platform: 'win32' } } });
      try {
        const id = await createProject('Windows fetch');
        // Test setup only: a ready repository cannot be connected on this host.
        await db().$executeRaw`
          INSERT INTO repositories (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
          VALUES (${id}::uuid, 'https://github.com/acme/win.git', 'github.com/acme/win', 'dev', 'ready', ${'d'.repeat(40)}, now())`;

        expectProblem(await fetchRepository(id), 501, 'unsupported-platform');
        expect((await getRepository(id)).body.state).toBe('ready');
      } finally {
        await restart();
      }
    });
  });

  describe('POST /api/projects/:id/repository/fetch: refused (every platform)', () => {
    it('answers 404 for an id that is not a UUID', async () => {
      expectProblem(await fetchRepository('not-a-uuid'), 404, 'project-not-found');
    });
  });

  describe('POST /api/projects/:id/repository/verify: refused (every platform)', () => {
    it('answers 404 for an id that is not a UUID', async () => {
      expectProblem(await verify('not-a-uuid'), 404, 'project-not-found');
    });
  });

  describe('DELETE /api/projects/:id/repository: refused (every platform)', () => {
    it('answers 404 for an id that is not a UUID', async () => {
      expectProblem(await disconnect('not-a-uuid'), 404, 'project-not-found');
    });
  });

  describe('start-up reconciliation', () => {
    it('marks a repository left connecting by a crash as failed (interrupted)', async () => {
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
        hasClone: false,
        failure: { code: 'interrupted', detail: '' },
      });
      expect((await getProject(id)).body.repository).toEqual({
        state: 'failed',
        url: 'https://github.com/acme/crashed.git',
        integrationBranch: 'dev',
      });
    });

    it('marks a repository left fetching by a crash as failed (interrupted), keeping its Clone', async () => {
      const id = await createProject('Crashed fetch');
      const sha = 'e'.repeat(40);
      const fetchedAt = '2026-11-13T10:00:00.000Z';
      // Test setup only: a crash mid-fetch cannot be produced through the API.
      await db().$executeRaw`
        INSERT INTO repositories (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
        VALUES (${id}::uuid, 'https://github.com/acme/fetching.git', 'github.com/acme/fetching', 'dev', 'fetching', ${sha}, ${fetchedAt}::timestamptz)`;

      await restart();

      expect((await getRepository(id)).body).toEqual({
        state: 'failed',
        url: 'https://github.com/acme/fetching.git',
        integrationBranch: 'dev',
        hasClone: true,
        headSha: sha,
        lastFetchedAt: fetchedAt,
        failure: { code: 'interrupted', detail: '' },
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
      expectProblem(
        await request(server())
          .post(`/api/projects/${id}/repository/fetch`)
          .set('Origin', STUDIO_ORIGIN),
        401,
      );
    });

    it('rejects an anonymous disconnect with 401 and one with a foreign Origin with 403', async () => {
      const id = await createProject('Guarded disconnect');
      // Test setup only: any state will do; nothing may change.
      await db().$executeRaw`
        INSERT INTO repositories (project_id, url, url_normalized, integration_branch, state, failure_code, failure_detail)
        VALUES (${id}::uuid, 'https://github.com/acme/guarded.git', 'github.com/acme/guarded', 'dev', 'failed', 'unknown', '')`;

      expectProblem(
        await request(server())
          .delete(`/api/projects/${id}/repository`)
          .set('Origin', STUDIO_ORIGIN),
        401,
      );
      expectProblem(
        await request(server())
          .delete(`/api/projects/${id}/repository`)
          .set({ Origin: 'http://evil.example', Cookie: cookie }),
        403,
      );
      expect((await getRepository(id)).body.state).toBe('failed');
    });

    it('rejects an anonymous verify with 401 and one with a foreign Origin with 403', async () => {
      const id = await createProject('Guarded verify');
      await insertAwaitingKey(id, 'guarded-v');

      expectProblem(
        await request(server())
          .post(`/api/projects/${id}/repository/verify`)
          .set('Origin', STUDIO_ORIGIN)
          .send({}),
        401,
      );
      expectProblem(
        await request(server())
          .post(`/api/projects/${id}/repository/verify`)
          .set({ Origin: 'http://evil.example', Cookie: cookie })
          .send({}),
        403,
      );
      expect((await getRepository(id)).body.state).toBe('awaiting_key');
    });

    it('rejects a fetch with a foreign Origin', async () => {
      const id = await createProject('Cross-site fetch');

      const response = await request(server())
        .post(`/api/projects/${id}/repository/fetch`)
        .set({ Origin: 'http://evil.example', Cookie: cookie });

      expectProblem(response, 403);
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
        hasClone: false,
      });
      const ready = await settled(id);
      expect(ready).toEqual({
        state: 'ready',
        url: fixture.url,
        integrationBranch: 'dev',
        hasClone: true,
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
        hasClone: false,
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
        hasClone: false,
      });
      expect(await settled(id)).toMatchObject({ state: 'ready', headSha: fixture.commits.main });
    });

    it('refuses a Retry with 409 repository-busy while an operation of the project is still queued, keeping the failure', async () => {
      const id = await createProject('Busy retry');
      expect((await connect(id, { url: fixture.url, integrationBranch: 'release' })).status).toBe(
        201,
      );
      expect((await settled(id)).failure).toMatchObject({ code: 'branch_not_found' });
      // Test setup only: an earlier operation's job still holds the project's job id (a delayed
      // job; this relies on the platform queue's BullMQ layout, acceptable in a test).
      const redis = new Redis(services.config.redisUrl, { maxRetriesPerRequest: null });
      const queue = new Queue('repository-git', { connection: redis, prefix: QUEUE_KEY_PREFIX });
      const jobId = `repository-${id}`;
      try {
        await queue.add('repository-git', {}, { jobId, delay: 600_000 });

        const response = await connect(id, { url: fixture.url, integrationBranch: 'release' });

        expectProblem(response, 409, 'repository-busy');
        expect(response.body).toMatchObject({
          title: 'Repository busy',
          detail: 'A connect or fetch of this repository is still running. Try again when it ends.',
        });
        expect((await getRepository(id)).body).toMatchObject({
          state: 'failed',
          failure: { code: 'branch_not_found' },
        });
      } finally {
        await queue.remove(jobId);
        await queue.close();
        redis.disconnect();
      }
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

      it('fails a fetch with timeout when the remote stops answering, keeping the Clone', async () => {
        const id = await createProject('Slow fetch');
        const remote = createGitFixture(fixtures, 'slow-fetch');
        expect((await connect(id, { url: remote.url, integrationBranch: 'dev' })).status).toBe(201);
        const ready = await settled(id);
        // Test setup only: the remote moves to a host that hangs.
        await db().$executeRaw`
          UPDATE repositories SET url = ${`https://127.0.0.1:${silentPort}/acme/slow.git`}
          WHERE project_id = ${id}::uuid`;
        await restart({ projects: { gitSettings: { fetchTimeoutMs: 1_500 } } });

        expect((await fetchRepository(id)).status).toBe(202);

        expect(await settled(id)).toMatchObject({
          state: 'failed',
          hasClone: true,
          headSha: ready.headSha,
          lastFetchedAt: ready.lastFetchedAt,
          failure: { code: 'timeout' },
        });
      });

      it('fails a fetch past the size limit with no usable Clone; only Retry repairs it', async () => {
        await restart();
        const remote = createGitFixture(fixtures, 'grows');
        const id = await createProject('Grows');
        expect((await connect(id, { url: remote.url, integrationBranch: 'dev' })).status).toBe(201);
        expect((await settled(id)).state).toBe('ready');
        pushCommit(remote, 'dev', { bigFileBytes: 4 * 1024 * 1024 });
        await restart({
          projects: { gitSettings: { maxCloneBytes: 256 * 1024, sizePollIntervalMs: 20 } },
        });

        expect((await fetchRepository(id)).status).toBe(202);

        const failed = await settled(id);
        expect(failed).toEqual({
          state: 'failed',
          url: remote.url,
          integrationBranch: 'dev',
          hasClone: false,
          failure: { code: 'size_limit', detail: expect.any(String) },
        });
        expectProblem(await fetchRepository(id), 409, 'no-usable-clone');

        await restart();
        expect((await connect(id, { url: remote.url, integrationBranch: 'dev' })).status).toBe(201);
        expect(await settled(id)).toMatchObject({ state: 'ready', hasClone: true });
      });
    });

    describe('fetch', () => {
      let remote: GitFixture;
      let id: string;
      let connected: { headSha: string; lastFetchedAt: string };

      beforeEach(async () => {
        remote = createGitFixture(fixtures, `fetch-${Date.now()}`);
        id = await createProject('Fetched');
        expect((await connect(id, { url: remote.url, integrationBranch: 'dev' })).status).toBe(201);
        connected = await settled(id);
        expect(connected).toMatchObject({ state: 'ready', headSha: remote.commits.dev });
      });

      it('picks up a new commit: 202 fetching at once, then ready with the new commit', async () => {
        const commit = pushCommit(remote, 'dev');

        const response = await fetchRepository(id);

        expect(response.status).toBe(202);
        expect(response.body).toEqual({
          state: 'fetching',
          url: remote.url,
          integrationBranch: 'dev',
          hasClone: true,
          headSha: connected.headSha,
          lastFetchedAt: connected.lastFetchedAt,
        });
        const fetched = await settled(id);
        expect(fetched).toEqual({
          state: 'ready',
          url: remote.url,
          integrationBranch: 'dev',
          hasClone: true,
          headSha: commit,
          lastFetchedAt: expect.stringMatching(ISO_8601),
        });
        expect(Date.parse(fetched.lastFetchedAt)).toBeGreaterThan(
          Date.parse(connected.lastFetchedAt),
        );
        expect((await getProject(id)).body.repository.state).toBe('ready');
      });

      it('keeps the commit and moves "Last fetched" on when nothing changed', async () => {
        expect((await fetchRepository(id)).status).toBe(202);

        const fetched = await settled(id);

        expect(fetched).toMatchObject({ state: 'ready', headSha: connected.headSha });
        expect(Date.parse(fetched.lastFetchedAt)).toBeGreaterThan(
          Date.parse(connected.lastFetchedAt),
        );
      });

      it('fails with branch_not_found when the branch is gone, keeping the Clone; Fetch works again later', async () => {
        deleteRemoteBranch(remote, 'dev');

        expect((await fetchRepository(id)).status).toBe(202);

        expect(await settled(id)).toEqual({
          state: 'failed',
          url: remote.url,
          integrationBranch: 'dev',
          hasClone: true,
          headSha: connected.headSha,
          lastFetchedAt: connected.lastFetchedAt,
          failure: {
            code: 'branch_not_found',
            detail: 'Branch "dev" was not found on the remote.',
          },
        });

        restoreRemoteBranch(remote, 'dev');
        const commit = pushCommit(remote, 'dev');
        expect((await fetchRepository(id)).status).toBe(202);
        expect(await settled(id)).toMatchObject({ state: 'ready', headSha: commit });
        expect((await getRepository(id)).body.failure).toBeUndefined();
      });

      it('fails with repository_not_found when the remote is gone, keeping the Clone', async () => {
        await rm(remote.bare, { recursive: true, force: true });

        expect((await fetchRepository(id)).status).toBe(202);

        const failed = await settled(id);
        expect(failed).toMatchObject({
          state: 'failed',
          hasClone: true,
          headSha: connected.headSha,
          lastFetchedAt: connected.lastFetchedAt,
          failure: { code: 'repository_not_found' },
        });
        // Redacted: the local path of the fixture is not in the detail.
        expect(failed.failure.detail).not.toContain(fixtures);
      });

      it('lets the store decide between concurrent fetches: one 202, one 409', async () => {
        const responses = await Promise.all([fetchRepository(id), fetchRepository(id)]);

        expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
        expectProblem(
          responses.find((response) => response.status === 409)!,
          409,
          'repository-busy',
        );
        expect((await settled(id)).state).toBe('ready');
      });

      it('refuses a fetch while connecting with 409 repository-busy', async () => {
        // Test setup only: hold the repository in `connecting` (a clone that has not finished).
        await db().$executeRaw`
          UPDATE repositories SET state = 'connecting', head_sha = NULL, last_fetched_at = NULL
          WHERE project_id = ${id}::uuid`;

        expectProblem(await fetchRepository(id), 409, 'repository-busy');
        expect((await getRepository(id)).body.state).toBe('connecting');
      });

      it('refuses a fetch after a failed connect with 409 no-usable-clone', async () => {
        const other = await createProject('Never cloned');
        const url = remote.url.replace(/\.git$/, '-missing.git');
        expect((await connect(other, { url, integrationBranch: 'dev' })).status).toBe(201);
        expect(await settled(other)).toMatchObject({ state: 'failed', hasClone: false });

        expectProblem(await fetchRepository(other), 409, 'no-usable-clone');
      });

      it('answers 404 for an unknown project and for a project without a repository', async () => {
        expectProblem(await fetchRepository(UNKNOWN_PROJECT), 404, 'project-not-found');
        expectProblem(await fetchRepository(await createProject('Empty')), 404, 'no-repository');
      });
    });

    describe('disconnect', () => {
      const clonesDir = () => join(dataDir, 'clones');
      const clonePath = (projectId: string) => join(clonesDir(), `${projectId}.git`);
      /** Entries of the clones folder that belong to the project (its Clone, partial Clones). */
      const entriesOf = async (projectId: string) =>
        existsSync(clonesDir())
          ? (await readdir(clonesDir())).filter((name) => name.startsWith(projectId))
          : [];

      async function connectedProject(name: string, remote: GitFixture = fixture) {
        const id = await createProject(name);
        expect((await connect(id, { url: remote.url, integrationBranch: 'dev' })).status).toBe(201);
        expect(await settled(id)).toMatchObject({ state: 'ready' });
        expect(existsSync(clonePath(id))).toBe(true);
        return id;
      }

      it('disconnects a ready repository: 204, the Clone and the record are gone, the project stays', async () => {
        const id = await connectedProject('Disconnect me');

        const response = await disconnect(id);

        expect(response.status).toBe(204);
        expect(response.text).toBe('');
        expectProblem(await getRepository(id), 404, 'no-repository');
        expect((await getProject(id)).body).toMatchObject({ id, repository: null });
        expect(await entriesOf(id)).toEqual([]);
        // Idempotent: there is nothing left to disconnect.
        expectProblem(await disconnect(id), 404, 'no-repository');
      });

      it('removes only the directory derived from that project id (path safety)', async () => {
        const target = await connectedProject('Target');
        const neighbour = await connectedProject(
          'Neighbour',
          createGitFixture(fixtures, `neighbour-${Date.now()}`),
        );
        // Look-alikes next to the Clone and elsewhere in the data directory must survive.
        const decoyFile = join(clonesDir(), `${target}.git-decoy`);
        const decoyDirs = [join(clonesDir(), target), join(dataDir, `${target}.git`)];
        const keep = join(dataDir, 'keep.txt');
        for (const dir of decoyDirs) await mkdir(dir, { recursive: true });
        await writeFile(decoyFile, 'decoy');
        await writeFile(keep, 'keep');
        try {
          expect((await disconnect(target)).status).toBe(204);

          expect(existsSync(clonePath(target))).toBe(false);
          for (const decoy of [decoyFile, ...decoyDirs, keep]) {
            expect(existsSync(decoy), decoy).toBe(true);
          }
          expect(existsSync(join(clonePath(neighbour), 'HEAD'))).toBe(true);
          expect((await getRepository(neighbour)).body.state).toBe('ready');
          expect((await fetchRepository(neighbour)).status).toBe(202);
          expect((await settled(neighbour)).state).toBe('ready');
        } finally {
          await Promise.all(
            [decoyFile, ...decoyDirs, keep].map((path) =>
              rm(path, { recursive: true, force: true }),
            ),
          );
        }
      });

      it('answers 404 for an unknown project and for a project without a repository', async () => {
        expectProblem(await disconnect(UNKNOWN_PROJECT), 404, 'project-not-found');
        expectProblem(await disconnect(await createProject('Nothing here')), 404, 'no-repository');
      });

      it('disconnects a failed repository', async () => {
        const id = await createProject('Failed then disconnected');
        const url = fixture.url.replace(/shop\.git$/, 'nowhere.git');
        expect((await connect(id, { url, integrationBranch: 'dev' })).status).toBe(201);
        expect((await settled(id)).state).toBe('failed');

        expect((await disconnect(id)).status).toBe(204);
        expectProblem(await getRepository(id), 404, 'no-repository');
      });

      it('frees the remote: the same remote connects again to another project, then back to the first', async () => {
        const first = await connectedProject('First holder');
        const second = await createProject('Second holder');
        expectProblem(
          await connect(second, { url: fixture.url, integrationBranch: 'dev' }),
          409,
          'remote-already-connected',
        );

        expect((await disconnect(first)).status).toBe(204);

        expect((await connect(second, { url: fixture.url, integrationBranch: 'dev' })).status).toBe(
          201,
        );
        expect(await settled(second)).toMatchObject({
          state: 'ready',
          headSha: fixture.commits.dev,
        });
        expect((await disconnect(second)).status).toBe(204);
        expect((await connect(first, { url: fixture.url, integrationBranch: 'main' })).status).toBe(
          201,
        );
        expect(await settled(first)).toMatchObject({
          state: 'ready',
          headSha: fixture.commits.main,
        });
      });

      describe('when files cannot be removed', () => {
        // The Git adapter refuses a clones folder that is not a plain directory, so swapping it
        // for a symlink makes the removal fail (also as root, unlike a permission change).
        async function breakClonesFolder() {
          await rename(clonesDir(), `${clonesDir()}-real`);
          await symlink(`${clonesDir()}-real`, clonesDir());
        }
        async function repairClonesFolder() {
          await rm(clonesDir(), { force: true });
          await rename(`${clonesDir()}-real`, clonesDir());
        }

        it('answers 202 disconnecting, keeps it on a repeat, and completes once removal works', async () => {
          const id = await connectedProject('Stuck files');
          await breakClonesFolder();
          try {
            const response = await disconnect(id);

            expect(response.status).toBe(202);
            expect(response.body).toEqual({
              state: 'disconnecting',
              url: fixture.url,
              integrationBranch: 'dev',
              hasClone: false,
            });
            expect((await getRepository(id)).body).toEqual(response.body);
            expect((await getProject(id)).body.repository).toEqual({
              state: 'disconnecting',
              url: fixture.url,
              integrationBranch: 'dev',
            });
            // A fetch or a new connect cannot start meanwhile.
            expectProblem(await fetchRepository(id), 409, 'repository-busy');
            expectProblem(
              await connect(id, { url: fixture.url, integrationBranch: 'dev' }),
              409,
              'repository-already-connected',
            );
            expect((await disconnect(id)).status).toBe(202);
          } finally {
            await repairClonesFolder();
          }

          expect((await disconnect(id)).status).toBe(204);
          expectProblem(await getRepository(id), 404, 'no-repository');
          expect(await entriesOf(id)).toEqual([]);
        });

        it('resumes the cleanup at start-up', async () => {
          const id = await connectedProject('Resumed at start-up');
          await breakClonesFolder();
          try {
            expect((await disconnect(id)).status).toBe(202);
          } finally {
            await repairClonesFolder();
          }

          await restart();

          expectProblem(await getRepository(id), 404, 'no-repository');
          expect(await entriesOf(id)).toEqual([]);
        });
      });

      describe('while an operation runs', () => {
        let silent: Server;
        let silentPort: number;
        const sockets = new Set<Socket>();

        beforeAll(async () => {
          // Accepts connections and never answers: the clone or fetch hangs until cancelled.
          silent = createServer((socket) => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
          });
          await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
          silentPort = (silent.address() as { port: number }).port;
        });

        afterAll(async () => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          await new Promise((resolve) => silent.close(resolve));
        });

        /** Waits until the remote has been contacted, so the operation is really running. */
        async function untilContacted() {
          const deadline = Date.now() + 10_000;
          while (sockets.size === 0) {
            if (Date.now() > deadline) throw new Error('the operation never reached the remote');
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }

        it('cancels a running connect: 204, no partial Clone, and the same id connects again at once', async () => {
          const id = await createProject('Cancelled connect');
          const hanging = `https://127.0.0.1:${silentPort}/acme/hang.git`;
          expect((await connect(id, { url: hanging, integrationBranch: 'dev' })).status).toBe(201);
          await untilContacted();
          expect((await getRepository(id)).body.state).toBe('connecting');

          const started = Date.now();
          expect((await disconnect(id)).status).toBe(204);

          expect(Date.now() - started).toBeLessThan(10_000);
          expectProblem(await getRepository(id), 404, 'no-repository');
          expect(await entriesOf(id)).toEqual([]);
          // The shared job id is free: no repository-busy 409.
          expect((await connect(id, { url: fixture.url, integrationBranch: 'dev' })).status).toBe(
            201,
          );
          expect(await settled(id)).toMatchObject({ state: 'ready', headSha: fixture.commits.dev });
        });

        it('cancels a running fetch: 204, and the aborted fetch writes nothing afterwards', async () => {
          const id = await connectedProject(
            'Cancelled fetch',
            createGitFixture(fixtures, `cancelled-fetch-${Date.now()}`),
          );
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          // Test setup only: the remote moves to a host that hangs.
          await db().$executeRaw`
            UPDATE repositories SET url = ${`https://127.0.0.1:${silentPort}/acme/hang.git`}
            WHERE project_id = ${id}::uuid`;
          expect((await fetchRepository(id)).status).toBe(202);
          await untilContacted();

          expect((await disconnect(id)).status).toBe(204);

          expectProblem(await getRepository(id), 404, 'no-repository');
          expect(await entriesOf(id)).toEqual([]);
          // A new connect of the project is not touched by the cancelled fetch.
          expect((await connect(id, { url: fixture.url, integrationBranch: 'dev' })).status).toBe(
            201,
          );
          expect(await settled(id)).toMatchObject({ state: 'ready', headSha: fixture.commits.dev });
        });
      });
    });
  });

  // Guard against a silent skip: in CI the Linux-only cases above must run.
  it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs the real-git cases in CI (Linux)', () => {
    expect(process.platform).toBe('linux');
  });
});
