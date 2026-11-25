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

// The definitions Project over HTTP on the real app (PostgreSQL and Redis via Testcontainers):
// its single instance, the refusals of Runs, Previews and the Environment file, the Agents
// route, and the pin that keeps it out of every worker claim.

// A throwaway worker token generated per run; no token is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const WORKER = randomUUID();
const WORKING_COPY = {
  runBranch: 'agent/add-a-health-check-r0b8e5c2d',
  commits: [{ id: 'c'.repeat(40), subject: 'Add GET /health' }],
  hasUncommittedChanges: false,
};
const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROBLEM = {
  definitionsProject: 'urn:agentic-studio:problem:definitions-project',
  definitionsProjectExists: 'urn:agentic-studio:problem:definitions-project-exists',
};

function expectProblem(response: request.Response, status: number, type: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
  expect(response.body.type).toBe(type);
}

describe('definitions Project API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  let cookie: string;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const asOperator = (call: request.Test) => call.set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
  const asWorker = (path: string, body: object) =>
    http().post(`/api/worker/${path}`).set('Authorization', `Bearer ${WORKER_TOKEN}`).send(body);

  const createProject = (body: object) => asOperator(http().post('/api/projects')).send(body);
  const createDefinitions = (name = 'Agent definitions') =>
    createProject({ name, kind: 'definitions' });
  const definitionsRepository = () =>
    http().get('/api/agents/definitions-repository').set('Cookie', cookie);
  const definitionsCount = async () => {
    const rows = await db().$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM projects WHERE kind = 'definitions'`;
    return Number(rows[0]!.count);
  };

  /** An ordinary Project with a ready Repository (test setup only: no Git clone needed). */
  async function readyProject(name: string) {
    const [project] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    const url = `https://git.example.test/acme/${project!.id}.git`;
    await db().$executeRaw`
      INSERT INTO repositories
        (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
      VALUES (${project!.id}::uuid, ${url}, ${url.slice(8, -4)}, 'dev', 'ready',
              ${randomBytes(20).toString('hex')}, now())`;
    return project!.id;
  }

  const setKind = (projectId: string, kind: 'code' | 'definitions') =>
    db().$executeRaw`UPDATE projects SET kind = ${kind} WHERE id = ${projectId}::uuid`;

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
    // Test isolation only; CASCADE also empties runs and the rest.
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    const status = await asWorker('status', {
      workerId: WORKER,
      runner: 'cli',
      providers: { claude_code: true, codex: true },
    });
    expect(status.status).toBe(204);
  });

  describe('creating it', () => {
    it('creates an ordinary Project unless the kind is given, and shows the kind in every answer', async () => {
      const ordinary = await createProject({ name: 'Shop' });
      const definitions = await createDefinitions();

      expect(ordinary.status).toBe(201);
      expect(ordinary.body).toMatchObject({ id: expect.stringMatching(UUID), kind: 'code' });
      expect(definitions.status).toBe(201);
      expect(definitions.body).toMatchObject({ name: 'Agent definitions', kind: 'definitions' });
      const listed = await http().get('/api/projects').set('Cookie', cookie);
      expect(
        (listed.body.items as { name: string; kind: string }[]).map((p) => [p.name, p.kind]),
      ).toEqual([
        ['Agent definitions', 'definitions'],
        ['Shop', 'code'],
      ]);
      const one = await http().get(`/api/projects/${definitions.body.id}`).set('Cookie', cookie);
      expect(one.body.kind).toBe('definitions');
    });

    it('refuses an unknown kind', async () => {
      const response = await createProject({ name: 'Odd', kind: 'archive' });

      expect(response.status).toBe(400);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    });

    it('refuses a second definitions Project with its reason, and still creates ordinary ones', async () => {
      expect((await createDefinitions('First')).status).toBe(201);

      const second = await createDefinitions('Second');

      expectProblem(second, 409, PROBLEM.definitionsProjectExists);
      expect((await createProject({ name: 'Shop' })).status).toBe(201);
      expect(await definitionsCount()).toBe(1);
    });

    it('lets exactly one of two parallel creates win', async () => {
      const answers = await Promise.all([
        createDefinitions('Parallel A'),
        createDefinitions('Parallel B'),
      ]);

      expect(answers.map((response) => response.status).sort()).toEqual([201, 409]);
      expectProblem(
        answers.find((response) => response.status === 409)!,
        409,
        PROBLEM.definitionsProjectExists,
      );
      expect(await definitionsCount()).toBe(1);
    });

    it('reports a taken name as a field error, not as a second definitions Project', async () => {
      await createProject({ name: 'Shop' });

      const taken = await createDefinitions('shop');

      expect(taken.status).toBe(409);
      expect(taken.body.errors).toEqual([expect.objectContaining({ path: 'name' })]);
    });

    it('accepts a new definitions Project once the first is gone', async () => {
      const first = await createDefinitions('First');
      await db().$executeRaw`DELETE FROM projects WHERE id = ${first.body.id as string}::uuid`;

      expect((await createDefinitions('Again')).status).toBe(201);
    });

    it('offers no way to change the kind: no route accepts it, and the database refuses other values', async () => {
      const ordinary = await createProject({ name: 'Shop' });
      const id = ordinary.body.id as string;

      const merge = await asOperator(http().put(`/api/projects/${id}/merge-method`)).send({
        mergeMethod: 'squash',
        kind: 'definitions',
      });

      expect(merge.status).toBe(400);
      expect((await http().get(`/api/projects/${id}`).set('Cookie', cookie)).body.kind).toBe(
        'code',
      );
      await expect(
        db().$executeRaw`UPDATE projects SET kind = 'archive' WHERE id = ${id}::uuid`,
      ).rejects.toThrow();
    });
  });

  describe('GET /api/agents/definitions-repository', () => {
    it('answers no Project until one is created', async () => {
      await createProject({ name: 'Shop' });

      const response = await definitionsRepository();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ project: null });
    });

    it('answers the Project with no Repository before one is connected', async () => {
      const created = await createDefinitions();

      const response = await definitionsRepository();

      expect(response.body).toEqual({ project: { id: created.body.id, repository: null } });
    });

    it('answers the Repository state, the Integration branch and the last fetched commit', async () => {
      const created = await createDefinitions();
      const head = randomBytes(20).toString('hex');
      const url = 'https://git.example.test/acme/agents.git';
      await db().$executeRaw`
        INSERT INTO repositories
          (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
        VALUES (${created.body.id as string}::uuid, ${url}, ${url.slice(8, -4)}, 'main', 'ready',
                ${head}, '2026-11-25T10:00:00.000Z')`;

      const response = await definitionsRepository();

      expect(response.body).toEqual({
        project: {
          id: created.body.id,
          repository: {
            state: 'ready',
            integrationBranch: 'main',
            headSha: head,
            lastFetchedAt: '2026-11-25T10:00:00.000Z',
          },
        },
      });
    });

    it('is for the operator session only', async () => {
      expect((await http().get('/api/agents/definitions-repository')).status).toBe(401);
      const withWorkerToken = await http()
        .get('/api/agents/definitions-repository')
        .set('Authorization', `Bearer ${WORKER_TOKEN}`);
      expect(withWorkerToken.status).toBe(401);
    });
  });

  describe('refusals', () => {
    let id: string;

    beforeEach(async () => {
      id = (await createDefinitions()).body.id as string;
    });

    const refused = (response: request.Response, what: string) => {
      expectProblem(response, 409, PROBLEM.definitionsProject);
      expect(response.body.refused).toBe(what);
    };

    it('refuses starting a Run', async () => {
      const response = await asOperator(http().post(`/api/projects/${id}/runs`)).send({
        task: 'Fix the login bug',
        provider: 'codex',
      });

      refused(response, 'run');
      const runs = await db().$queryRaw<{ count: bigint }[]>`SELECT count(*) FROM runs`;
      expect(Number(runs[0]!.count)).toBe(0);
    });

    it('refuses listing its Runs', async () => {
      refused(await http().get(`/api/projects/${id}/runs`).set('Cookie', cookie), 'run');
    });

    it('refuses setting an Environment file', async () => {
      refused(
        await asOperator(http().put(`/api/projects/${id}/environment-file`)).send({
          path: '.env',
          content: 'KEY=test-only\n',
        }),
        'environment_file',
      );
    });

    it('refuses reading an Environment file', async () => {
      refused(
        await http().get(`/api/projects/${id}/environment-file`).set('Cookie', cookie),
        'environment_file',
      );
    });

    it('refuses removing an Environment file', async () => {
      refused(
        await asOperator(http().delete(`/api/projects/${id}/environment-file`)),
        'environment_file',
      );
    });

    it('refuses saving Preview settings', async () => {
      refused(
        await asOperator(http().put(`/api/projects/${id}/preview/settings`)).send({
          composeFile: 'compose.yaml',
          service: 'web',
          port: 3000,
        }),
        'preview',
      );
    });

    it('refuses removing Preview settings', async () => {
      refused(await asOperator(http().delete(`/api/projects/${id}/preview/settings`)), 'preview');
    });

    it('refuses a Preview build', async () => {
      refused(await asOperator(http().post(`/api/projects/${id}/preview/builds`)), 'preview');
    });

    it('refuses a Preview stop', async () => {
      refused(await asOperator(http().post(`/api/projects/${id}/preview/stop`)), 'preview');
    });

    it('refuses a Preview reset', async () => {
      refused(await asOperator(http().post(`/api/projects/${id}/preview/reset-data`)), 'preview');
    });

    it('does not refuse an ordinary Project the same way', async () => {
      const ordinary = await readyProject('Shop');

      const file = await asOperator(http().put(`/api/projects/${ordinary}/environment-file`)).send({
        path: '.env',
        content: 'KEY=test-only\n',
      });
      const runs = await http().get(`/api/projects/${ordinary}/runs`).set('Cookie', cookie);

      expect(file.status).toBe(200);
      expect(runs.status).toBe(200);
    });
  });

  describe('disconnecting', () => {
    it('works as for any Project: the Repository goes, the Project stays', async () => {
      const created = await createDefinitions();
      const id = created.body.id as string;
      const url = 'https://git.example.test/acme/agents.git';
      await db().$executeRaw`
        INSERT INTO repositories
          (project_id, url, url_normalized, integration_branch, state, deploy_key_secret_id, public_key)
        VALUES (${id}::uuid, ${url}, ${url.slice(8, -4)}, 'main', 'awaiting_key',
                gen_random_uuid(), 'placeholder public key')`;

      const response = await asOperator(http().delete(`/api/projects/${id}/repository`));

      expect(response.status).toBeLessThan(300);
      expect((await http().get(`/api/projects/${id}`).set('Cookie', cookie)).body.kind).toBe(
        'definitions',
      );
    });
  });

  describe('the agent worker never receives work that names it', () => {
    async function queuedRun() {
      const project = await readyProject('Pinned');
      const started = await asOperator(http().post(`/api/projects/${project}/runs`)).send({
        task: 'Add a health check',
        provider: 'claude_code',
      });
      expect(started.status).toBe(201);
      return { project, runId: started.body.id as string };
    }

    it('skips a hand-inserted Run of the definitions Project in the Run claim', async () => {
      const { project, runId } = await queuedRun();
      await setKind(project, 'definitions');

      const claim = await asWorker('runs/claim', { workerId: WORKER });

      expect(claim.status).toBe(204);
      await setKind(project, 'code');
      const control = await asWorker('runs/claim', { workerId: WORKER });
      expect(control.status).toBe(200);
      expect(control.body.runId).toBe(runId);
    });

    it('skips the lookups of a hand-inserted Run of the definitions Project', async () => {
      const { project, runId } = await queuedRun();
      expect((await asWorker('runs/claim', { workerId: WORKER })).status).toBe(200);
      await asWorker(`runs/${runId}/state`, { workerId: WORKER, state: 'running' });
      const stepped = await asWorker(`runs/${runId}/steps`, {
        workerId: WORKER,
        index: 1,
        kind: 'start',
        result: { outcome: 'done', summary: 'Done.', sessionRef: 'session-1' },
        workingCopy: WORKING_COPY,
      });
      expect(stepped.status).toBe(204);
      const ended = await asWorker(`runs/${runId}/state`, {
        workerId: WORKER,
        state: 'succeeded',
        delivery: { outcome: 'delivered', pullRequest: PULL_REQUEST },
      });
      expect(ended.status).toBe(204);
      const refresh = await asOperator(http().post(`/api/runs/${runId}/pull-request/refresh`)).send(
        {},
      );
      expect(refresh.status).toBeLessThan(300);
      await setKind(project, 'definitions');

      const claim = await asWorker('lookups/claim', { workerId: WORKER });

      expect(claim.status).toBe(204);
      await setKind(project, 'code');
      const control = await asWorker('lookups/claim', { workerId: WORKER });
      expect(control.status).toBe(200);
      expect(control.body).toHaveLength(1);
      expect(control.body[0]).toMatchObject({ runId });
    });
  });
});
