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

// Story #16, main seam: the real app over HTTP, with PostgreSQL and Redis from Testcontainers.
// It lives outside src/modules/ because building the whole app reaches the database client,
// which architecture:api forbids for anything under a feature folder (tests included).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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
    app = await startStudioApp(services.config);
    cookie = await signIn(app);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  beforeEach(async () => {
    // Test isolation only; every assertion goes through the HTTP API.
    await app.get<DatabaseClient>(DATABASE_CLIENT).$executeRaw`TRUNCATE TABLE projects`;
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

    it.each([
      ['an empty name', { name: '' }],
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
