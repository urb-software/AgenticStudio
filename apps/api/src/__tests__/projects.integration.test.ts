import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// The real app over HTTP (PostgreSQL and Redis via Testcontainers), outside src/modules/ because
// building the whole app reaches the database client, which architecture:api forbids there.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A throwaway worker token generated per run; none is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function expectProblem(response: request.Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
}

describe('projects API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  let cookie: string;

  const createProject = (body: unknown) =>
    request(app.getHttpServer())
      .post('/api/projects')
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send(body as object);

  const listProjects = () =>
    request(app.getHttpServer()).get('/api/projects').set('Cookie', cookie);

  const listedNames = async () => {
    const response = await listProjects();
    expect(response.status).toBe(200);
    return (response.body.items as { name: string }[]).map((project) => project.name);
  };

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp({ ...services.config, workerToken: WORKER_TOKEN_DIGEST });
    cookie = await signIn(app);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  beforeEach(async () => {
    // Test isolation only; every assertion goes through the HTTP API.
    await app.get<DatabaseClient>(DATABASE_CLIENT).$executeRaw`TRUNCATE TABLE projects CASCADE`;
  });

  describe('GET /api/projects', () => {
    it('returns an empty list when there are no projects', async () => {
      const response = await listProjects();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [] });
    });

    it('lists projects newest first', async () => {
      for (const name of ['Alpha', 'Beta', 'Gamma']) {
        expect((await createProject({ name })).status).toBe(201);
      }

      expect(await listedNames()).toEqual(['Gamma', 'Beta', 'Alpha']);
    });

    it('breaks a createdAt tie by id, highest first', async () => {
      // Test setup only: equal timestamps cannot be produced reliably through the API.
      const createdAt = new Date('2026-11-13T10:00:00.000Z');
      await app.get<DatabaseClient>(DATABASE_CLIENT).$executeRaw`
        INSERT INTO projects (id, name, name_normalized, created_at) VALUES
          ('00000000-0000-4000-8000-00000000000a'::uuid, 'Tie A', 'tie a', ${createdAt}),
          ('00000000-0000-4000-8000-00000000000c'::uuid, 'Tie C', 'tie c', ${createdAt}),
          ('00000000-0000-4000-8000-00000000000b'::uuid, 'Tie B', 'tie b', ${createdAt})`;

      expect(await listedNames()).toEqual(['Tie C', 'Tie B', 'Tie A']);
    });

    it('returns each project with the same shape as the create response', async () => {
      const created = await createProject({ name: 'Shape' });

      const response = await listProjects();

      expect(response.body).toEqual({ items: [created.body] });
    });
  });

  describe('POST /api/projects', () => {
    it('creates a project with a trimmed, whitespace-collapsed name and returns 201', async () => {
      const response = await createProject({ name: '  Agentic \t  Studio\n ' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        id: expect.stringMatching(UUID),
        name: 'Agentic Studio',
        mergeMethod: 'squash',
        kind: 'code',
        // No default agent is named yet.
        defaultAgent: null,
        defaultWorkflow: null,
        createdAt: expect.stringMatching(ISO_8601),
      });
      expect(await listedNames()).toEqual(['Agentic Studio']);
    });

    it('keeps the case of the name for display', async () => {
      const response = await createProject({ name: 'MyAPI Gateway' });

      expect(response.body.name).toBe('MyAPI Gateway');
    });

    it('accepts 100 characters, measured after normalization', async () => {
      const name = `${'a'.repeat(50)} ${'b'.repeat(49)}`;

      const response = await createProject({
        name: `   ${'a'.repeat(50)}      ${'b'.repeat(49)}  `,
      });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe(name);
    });

    it('stores the name in Unicode NFC', async () => {
      const response = await createProject({ name: 'Cafe\u0301' });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe('Caf\u00e9');
    });

    it('counts the length in code points: 100 astral characters are accepted', async () => {
      const name = '\u{1F600}'.repeat(100);

      const response = await createProject({ name });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe(name);
      expect(await listedNames()).toEqual([name]);
    });

    it.each([
      ['an empty name', { name: '' }],
      [
        '101 characters written in NFD (202 code points before NFC)',
        { name: 'e\u0301'.repeat(101) },
      ],
      ['a name over 100 code points (astral characters)', { name: '\u{1F600}'.repeat(101) }],
      ['a whitespace-only name', { name: ' \t\n ' }],
      ['a name over 100 characters', { name: 'x'.repeat(101) }],
      [
        'a name over 100 characters after normalization',
        { name: `${'a'.repeat(50)} ${'b'.repeat(50)}` },
      ],
      ['a missing name', {}],
      ['a non-string name', { name: 42 }],
    ])('rejects %s with 400 problem+json and a field error on name', async (_case, body) => {
      const response = await createProject(body);

      expectProblem(response, 400);
      expect(response.body.errors).toEqual([{ path: 'name', message: expect.any(String) }]);
      expect(await listedNames()).toEqual([]);
    });

    it('rejects an unknown field with 400: the request schema is closed', async () => {
      const response = await createProject({ name: 'Agentic Studio', owner: 'someone' });

      expectProblem(response, 400);
      expect(response.body.errors).toEqual([
        { path: '', message: expect.stringContaining('owner') },
      ]);
      expect(await listedNames()).toEqual([]);
    });

    it.each([
      ['the same name', 'Agentic Studio'],
      ['a name differing only in case', 'AGENTIC studio'],
      ['a name differing only in whitespace', '  Agentic    Studio '],
      ['a name differing in case and whitespace', ' agentic\tSTUDIO'],
    ])('rejects %s as a duplicate with 409 problem+json', async (_case, duplicate) => {
      expect((await createProject({ name: 'Agentic Studio' })).status).toBe(201);

      const response = await createProject({ name: duplicate });

      expectProblem(response, 409);
      expect(response.body.errors).toEqual([{ path: 'name', message: expect.any(String) }]);
      expect(await listedNames()).toEqual(['Agentic Studio']);
    });

    it('treats the NFC and NFD spellings of a name as a duplicate', async () => {
      expect((await createProject({ name: 'Caf\u00e9 Cr\u00e8me' })).status).toBe(201);

      expectProblem(await createProject({ name: 'Cafe\u0301 Cre\u0300me' }), 409);
      expect(await listedNames()).toEqual(['Caf\u00e9 Cr\u00e8me']);
    });

    it('treats an NFD spelling in surrounding whitespace as a duplicate', async () => {
      expect((await createProject({ name: 'Caf\u00e9' })).status).toBe(201);

      expectProblem(await createProject({ name: ' \tCAFE\u0301 \u3000' }), 409);
      expect(await listedNames()).toEqual(['Caf\u00e9']);
    });

    it('compares names case-insensitively beyond ASCII', async () => {
      expect((await createProject({ name: 'Ärger Über Öl' })).status).toBe(201);

      expectProblem(await createProject({ name: 'ärger über öl' }), 409);
    });

    it('lets the database decide between concurrent duplicates: one 201, one 409', async () => {
      const responses = await Promise.all([
        createProject({ name: 'Race' }),
        createProject({ name: 'RACE' }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      expect(await listedNames()).toHaveLength(1);
    });
  });

  describe('PUT /api/projects/:id/merge-method', () => {
    const setMergeMethod = (projectId: string, body: unknown, headers: object = {}) =>
      request(app.getHttpServer())
        .put(`/api/projects/${projectId}/merge-method`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie, ...headers })
        .send(body as object);
    const getProject = (projectId: string) =>
      request(app.getHttpServer()).get(`/api/projects/${projectId}`).set('Cookie', cookie);

    it('changes the method of the project, answers the project, and shows it on the page and the list', async () => {
      const created = await createProject({ name: 'Mergeable' });
      expect(created.body.mergeMethod).toBe('squash');

      const changed = await setMergeMethod(created.body.id as string, {
        mergeMethod: 'merge_commit',
      });

      expect(changed.status).toBe(200);
      expect(changed.body).toEqual({ ...created.body, mergeMethod: 'merge_commit' });
      expect((await getProject(created.body.id as string)).body.mergeMethod).toBe('merge_commit');
      expect((await listProjects()).body.items[0].mergeMethod).toBe('merge_commit');
      const back = await setMergeMethod(created.body.id as string, { mergeMethod: 'squash' });
      expect(back.body.mergeMethod).toBe('squash');
    });

    it('does not take the method when a project is created', async () => {
      const response = await createProject({ name: 'Chosen', mergeMethod: 'merge_commit' });

      expectProblem(response, 400);
      expect(await listedNames()).toEqual([]);
    });

    it.each([
      ['an unknown value', { mergeMethod: 'rebase' }],
      ['a missing value', {}],
      ['an unknown field', { mergeMethod: 'squash', extra: true }],
    ])('refuses %s with 400 and keeps the method', async (_name, body) => {
      const created = await createProject({ name: 'Strict' });

      const response = await setMergeMethod(created.body.id as string, body);

      expectProblem(response, 400);
      expect((await getProject(created.body.id as string)).body.mergeMethod).toBe('squash');
    });

    it('answers 404 for an unknown project and for an id that is not a UUID', async () => {
      const unknown = await setMergeMethod(randomUUID(), { mergeMethod: 'squash' });
      const malformed = await setMergeMethod('not-a-uuid', { mergeMethod: 'squash' });

      expectProblem(unknown, 404);
      expectProblem(malformed, 404);
    });

    it('is an operator route: no session, a foreign origin and the worker token are refused', async () => {
      const created = await createProject({ name: 'Guarded' });
      const id = created.body.id as string;

      expectProblem(await setMergeMethod(id, { mergeMethod: 'merge_commit' }, { Cookie: '' }), 401);
      expectProblem(
        await setMergeMethod(
          id,
          { mergeMethod: 'merge_commit' },
          { Origin: 'http://evil.example' },
        ),
        403,
      );
      expectProblem(
        await setMergeMethod(
          id,
          { mergeMethod: 'merge_commit' },
          { Cookie: '', Authorization: `Bearer ${WORKER_TOKEN}` },
        ),
        401,
      );
      expect((await getProject(id)).body.mergeMethod).toBe('squash');
    });
  });

  describe('authentication', () => {
    it('rejects an anonymous GET with 401 problem+json', async () => {
      const response = await request(app.getHttpServer()).get('/api/projects');

      expectProblem(response, 401);
    });

    it('rejects an anonymous POST with 401 problem+json and creates nothing', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/projects')
        .set('Origin', STUDIO_ORIGIN)
        .send({ name: 'Anonymous' });

      expectProblem(response, 401);
      expect(await listedNames()).toEqual([]);
    });

    it('rejects GET /api/projects with 401 after logout', async () => {
      const server = app.getHttpServer();
      const ownCookie = await signIn(app);
      expect((await request(server).get('/api/projects').set('Cookie', ownCookie)).status).toBe(
        200,
      );

      const logout = await request(server)
        .post('/api/auth/logout')
        .set({ Origin: STUDIO_ORIGIN, Cookie: ownCookie });
      expect(logout.status).toBe(204);

      // A browser drops the cleared cookie; replaying the old session cookie must fail too.
      expectProblem(await request(server).get('/api/projects').set('Cookie', ownCookie), 401);
    });

    it('rejects a POST with a foreign Origin and creates nothing', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/projects')
        .set({ Origin: 'http://evil.example', Cookie: cookie })
        .send({ name: 'Cross-site' });

      expectProblem(response, 403);
      expect(await listedNames()).toEqual([]);
    });
  });

  describe('persistence', () => {
    it('keeps projects across an API restart', async () => {
      const created = await createProject({ name: 'Survivor' });
      expect(created.status).toBe(201);

      await app.close();
      app = await startStudioApp(services.config);
      cookie = await signIn(app);

      const response = await listProjects();
      expect(response.body).toEqual({ items: [created.body] });
    });
  });
});
