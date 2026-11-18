import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import { SECRET_STORE, type SecretStore } from '../platform/secrets/index.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// A Project's Environment file over HTTP on the real app (PostgreSQL and Redis via
// Testcontainers): the content never comes back and a Run's log is redacted with its values;
// every value is a throwaway generated per run.

const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const PASSWORD_VALUE = `test-only-pw-${randomBytes(6).toString('hex')}`;
const KEY_VALUE = `test-only-key-${randomBytes(6).toString('hex')}`;
const CONTENT = `# test stack\nDB_PASSWORD=${PASSWORD_VALUE}\nexport API_KEY="${KEY_VALUE}"\n`;
const REDACTED = '••••••[redacted]';
const PROJECT_NOT_FOUND = 'urn:agentic-studio:problem:project-not-found';
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function expectProblem(response: request.Response, status: number, type?: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
  if (type) expect(response.body.type).toBe(type);
}

/** No value of the file in the response, in body or headers. */
function expectNoContent(response: request.Response) {
  const text = `${JSON.stringify(response.headers)}${response.text ?? ''}`;
  expect(text).not.toContain(PASSWORD_VALUE);
  expect(text).not.toContain(KEY_VALUE);
}

describe('Environment files API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  let cookie: string;
  const W1 = randomUUID();

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const fileUrl = (projectId: string) => `/api/projects/${projectId}/environment-file`;
  const put = (projectId: string, body: object) =>
    http().put(fileUrl(projectId)).set({ Origin: STUDIO_ORIGIN, Cookie: cookie }).send(body);
  const get = (projectId: string) => http().get(fileUrl(projectId)).set('Cookie', cookie);
  const remove = (projectId: string) =>
    http().delete(fileUrl(projectId)).set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
  const worker = (path: string, body: object) =>
    http()
      .post(`/api/worker/runs/${path}`)
      .set('Authorization', `Bearer ${WORKER_TOKEN}`)
      .send(body);

  /** A project whose Repository is ready (test setup only: no Clone on disk). */
  async function readyProject(): Promise<string> {
    const name = `Project ${randomUUID()}`;
    const [project] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    const path = `git.example.test/acme/${project!.id}`;
    await db().$executeRaw`
      INSERT INTO repositories
        (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
      VALUES (${project!.id}::uuid, ${`https://${path}.git`}, ${path}, 'dev', 'ready',
              ${randomBytes(20).toString('hex')}, now())`;
    return project!.id;
  }

  async function startRun(projectId: string): Promise<string> {
    const started = await http()
      .post(`/api/projects/${projectId}/runs`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send({ task: 'Run the integration tests', provider: 'codex' });
    expect(started.status).toBe(201);
    return started.body.id as string;
  }

  /** The references the secret store holds under an owner label (through the port). */
  const stored = (owner: string) => app.get<SecretStore>(SECRET_STORE).listOlderThan(owner, 0);
  const snapshotCount = async () => (await stored('executions.run-environment-file')).length;
  const fileContents = () => stored('projects.environment-file');

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
    // Test isolation only; CASCADE also empties repositories, environment_files and runs.
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    for (const owner of ['projects.environment-file', 'executions.run-environment-file']) {
      for (const reference of await stored(owner)) {
        await app.get<SecretStore>(SECRET_STORE).delete(reference);
      }
    }
    const status = await http()
      .post('/api/worker/status')
      .set('Authorization', `Bearer ${WORKER_TOKEN}`)
      .send({ workerId: W1, runner: 'cli', providers: { claude_code: true, codex: true } });
    expect(status.status).toBe(204);
  });

  describe('the operator setting', () => {
    it('sets the file and shows its path, size and last change, never its content', async () => {
      const projectId = await readyProject();

      const saved = await put(projectId, { path: '.env', content: CONTENT });

      expect(saved.status).toBe(200);
      expect(saved.body).toEqual({
        path: '.env',
        sizeBytes: Buffer.byteLength(CONTENT),
        updatedAt: expect.stringMatching(ISO_8601),
      });
      expectNoContent(saved);
      const read = await get(projectId);
      expect(read.status).toBe(200);
      expect(read.body).toEqual(saved.body);
      expectNoContent(read);
      expectNoContent(await http().get(`/api/projects/${projectId}`).set('Cookie', cookie));
      expectNoContent(await http().get('/api/projects').set('Cookie', cookie));
      // The project's row holds a reference, never the content; the secret store holds it.
      const rows = await db().$queryRaw<{ row: string }[]>`
        SELECT row_to_json(e)::text AS row FROM environment_files e`;
      expect(rows.map((row) => row.row).join('\n')).not.toContain(PASSWORD_VALUE);
      const [reference] = await fileContents();
      expect(await app.get<SecretStore>(SECRET_STORE).get(reference!)).toBe(CONTENT);
    });

    it('answers null while no file is set', async () => {
      const projectId = await readyProject();
      const read = await get(projectId);
      expect(read.status).toBe(200);
      expect(read.text).toBe('null');
      expect(read.body).toBeNull();
    });

    it('replaces the file, deleting the replaced content, and removes it', async () => {
      const projectId = await readyProject();
      await put(projectId, { path: '.env', content: CONTENT });

      const replaced = await put(projectId, { path: 'config/test.env', content: 'A=test-only\n' });
      expect(replaced.status).toBe(200);
      expect(replaced.body).toMatchObject({ path: 'config/test.env', sizeBytes: 12 });
      const references = await fileContents();
      expect(references).toHaveLength(1);
      expect(await app.get<SecretStore>(SECRET_STORE).get(references[0]!)).toBe('A=test-only\n');

      const removed = await remove(projectId);
      expect(removed.status).toBe(204);
      expect((await get(projectId)).body).toBeNull();
      expect((await remove(projectId)).status).toBe(204);
      expect(await fileContents()).toEqual([]);
    });

    it.each([
      ['../.env', 'inside the repository'],
      ['/etc/app.env', 'relative'],
      ['.git/config', '.git'],
      ['config//.env', 'empty segments'],
      ['config\\.env', 'forward slashes'],
      ['', 'Enter a path'],
    ])('refuses the path %j with a field error that says why', async (path, why) => {
      const projectId = await readyProject();

      const response = await put(projectId, { path, content: CONTENT });

      expectProblem(response, 422);
      expect(response.body.errors).toEqual([
        { path: 'path', message: expect.stringContaining(why) },
      ]);
      expectNoContent(response);
      expect((await get(projectId)).body).toBeNull();
    });

    it('refuses content over 64 KiB, or a malformed body, without echoing it', async () => {
      const projectId = await readyProject();
      const big = `K=${PASSWORD_VALUE}${'v'.repeat(64 * 1024)}`;

      const tooBig = await put(projectId, { path: '.env', content: big });
      expectProblem(tooBig, 422);
      expect(tooBig.body.errors[0].path).toBe('content');
      expectNoContent(tooBig);
      const extra = await put(projectId, {
        path: '.env',
        content: CONTENT,
        secret: PASSWORD_VALUE,
      });
      expectProblem(extra, 422);
      expectNoContent(extra);
      expectProblem(await put(projectId, { path: '.env' }), 422);
    });

    it('accepts a full 64 KiB file whose JSON is larger than the usual 100 KiB body limit', async () => {
      const projectId = await readyProject();
      // Every quote is escaped in JSON: about 128 KiB on the wire.
      const content = `Q=${'"'.repeat(64 * 1024 - 2)}`;

      const saved = await put(projectId, { path: '.env', content });

      expect(saved.status).toBe(200);
      expect(saved.body.sizeBytes).toBe(64 * 1024);
    });

    it('answers 404 for an unknown project', async () => {
      const unknown = randomUUID();
      expectProblem(await get(unknown), 404, PROJECT_NOT_FOUND);
      expectProblem(await put(unknown, { path: '.env', content: CONTENT }), 404, PROJECT_NOT_FOUND);
      expectProblem(await remove(unknown), 404, PROJECT_NOT_FOUND);
    });

    it('requires the operator session, and the mutation Origin', async () => {
      const projectId = await readyProject();
      await put(projectId, { path: '.env', content: CONTENT });

      expectProblem(await http().get(fileUrl(projectId)), 401);
      expectProblem(
        await http()
          .put(fileUrl(projectId))
          .set('Origin', STUDIO_ORIGIN)
          .send({ path: '.env', content: 'A=x' }),
        401,
      );
      expectProblem(await http().delete(fileUrl(projectId)).set('Origin', STUDIO_ORIGIN), 401);
      expectProblem(
        await http()
          .put(fileUrl(projectId))
          .set('Cookie', cookie)
          .send({ path: '.env', content: 'A=x' }),
        403,
      );
      expectProblem(
        await http().get(fileUrl(projectId)).set('Authorization', `Bearer ${WORKER_TOKEN}`),
        401,
      );
      expect((await get(projectId)).body).toMatchObject({ path: '.env' });
    });

    it('stays in place when the Repository is disconnected', async () => {
      const projectId = await readyProject();
      await put(projectId, { path: '.env', content: CONTENT });

      const disconnected = await http()
        .delete(`/api/projects/${projectId}/repository`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
      expect([202, 204]).toContain(disconnected.status);

      expect((await get(projectId)).body).toMatchObject({ path: '.env' });
    });
  });

  describe('delivery with a Run', () => {
    it('hands the file to the worker that claims the Run, and the Run records that it did', async () => {
      const projectId = await readyProject();
      await put(projectId, { path: 'config/test.env', content: CONTENT });
      const runId = await startRun(projectId);

      const claimed = await worker('claim', { workerId: W1 });

      expect(claimed.status).toBe(200);
      expect(claimed.body).toMatchObject({
        runId,
        kind: 'start',
        // Delivery never commits or pushes what Studio placed.
        studioPaths: ['config/test.env'],
        environmentFile: { path: 'config/test.env', content: CONTENT },
      });
      const run = await http().get(`/api/runs/${runId}`).set('Cookie', cookie);
      expect(run.body.environmentFileSupplied).toBe(true);
      expectNoContent(run);
      expectNoContent(await http().get('/api/runs').set('Cookie', cookie));
      expectNoContent(await http().get(`/api/projects/${projectId}/runs`).set('Cookie', cookie));
    });

    it('carries the file in the claim only: no other worker route, and no other worker, gets it', async () => {
      const projectId = await readyProject();
      await put(projectId, { path: '.env', content: CONTENT });
      const runId = await startRun(projectId);
      const W2 = randomUUID();
      expect((await worker('claim', { workerId: W1 })).body.environmentFile).toBeDefined();

      const responses = [
        // Another worker asking for work gets nothing: the Run is held.
        await worker('claim', { workerId: W2 }),
        await worker(`${runId}/heartbeat`, { workerId: W1 }),
        await worker('states', { workerId: W1, runIds: [runId] }),
        await worker(`${runId}/state`, { workerId: W1, state: 'running' }),
        await worker(`${runId}/events`, {
          workerId: W1,
          events: [
            { seq: 1, at: new Date().toISOString(), stepIndex: 1, kind: 'output', text: 'x' },
          ],
        }),
        await worker(`${runId}/steps`, {
          workerId: W1,
          index: 1,
          kind: 'start',
          result: { outcome: 'done', summary: 'Done.' },
          workingCopy: {
            runBranch: 'agent/x-r0b8e5c2d',
            commits: [],
            hasUncommittedChanges: false,
          },
        }),
        await http()
          .post('/api/worker/status')
          .set('Authorization', `Bearer ${WORKER_TOKEN}`)
          .send({ workerId: W2, runner: 'cli', providers: { claude_code: true, codex: true } }),
      ];

      expect(responses[0]!.status).toBe(204);
      for (const response of responses) {
        expect(response.status).toBeLessThan(300);
        expectNoContent(response);
        expect(response.text ?? '').not.toContain('environmentFile');
      }
    });

    it('supplies nothing to a Run of a project without a file', async () => {
      const projectId = await readyProject();
      const runId = await startRun(projectId);

      const claimed = await worker('claim', { workerId: W1 });

      expect(claimed.body.runId).toBe(runId);
      expect(claimed.body.studioPaths).toEqual([]);
      expect(claimed.body).not.toHaveProperty('environmentFile');
      expect((await http().get(`/api/runs/${runId}`).set('Cookie', cookie)).body).toMatchObject({
        environmentFileSupplied: false,
      });
    });

    it('gives later Runs the changed file, while a claimed Run keeps its snapshot', async () => {
      const projectId = await readyProject();
      await put(projectId, { path: '.env', content: CONTENT });
      const first = await startRun(projectId);
      expect((await worker('claim', { workerId: W1 })).body.runId).toBe(first);
      expect((await worker(`${first}/state`, { workerId: W1, state: 'running' })).status).toBe(204);

      await put(projectId, { path: '.env', content: 'OTHER=test-only-later\n' });
      await worker(`${first}/events`, {
        workerId: W1,
        events: [
          {
            seq: 1,
            at: new Date().toISOString(),
            stepIndex: 1,
            kind: 'output',
            text: `pw ${PASSWORD_VALUE}`,
          },
        ],
      });
      const events = await http().get(`/api/runs/${first}/events`).set('Cookie', cookie);
      expect(events.body.events[0].text).toBe(`pw ${REDACTED}`);
      expect(
        (
          await worker(`${first}/state`, {
            workerId: W1,
            state: 'succeeded',
            delivery: { outcome: 'none' },
          })
        ).status,
      ).toBe(204);

      const second = await startRun(projectId);
      const claimed = await worker('claim', { workerId: W1 });
      expect(claimed.body).toMatchObject({
        runId: second,
        environmentFile: { path: '.env', content: 'OTHER=test-only-later\n' },
      });
      expect((await worker(`${second}/state`, { workerId: W1, state: 'running' })).status).toBe(
        204,
      );
      expect(
        (
          await worker(`${second}/state`, {
            workerId: W1,
            state: 'succeeded',
            delivery: { outcome: 'none' },
          })
        ).status,
      ).toBe(204);
      await remove(projectId);
      const third = await startRun(projectId);
      const none = await worker('claim', { workerId: W1 });
      expect(none.body.runId).toBe(third);
      expect(none.body).not.toHaveProperty('environmentFile');
    });

    it('keeps the snapshot while a failed delivery can be retried: the retry claim has no content, its reports are redacted', async () => {
      const projectId = await readyProject();
      await put(projectId, { path: '.env', content: CONTENT });
      const runId = await startRun(projectId);
      await worker('claim', { workerId: W1 });
      await worker(`${runId}/state`, { workerId: W1, state: 'running' });
      const workingCopy = (subject: string) => ({
        runBranch: 'agent/x-r0b8e5c2d',
        commits: [{ id: 'c'.repeat(40), subject }],
        hasUncommittedChanges: false,
      });
      expect(
        (
          await worker(`${runId}/state`, {
            workerId: W1,
            state: 'failed',
            failure: { code: 'delivery_failed', detail: 'push refused' },
            workingCopy: workingCopy('Add a feature'),
          })
        ).status,
      ).toBe(204);
      expect(await snapshotCount()).toBe(1);

      const retry = () =>
        http()
          .post(`/api/runs/${runId}/retry-delivery`)
          .set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
      expect((await retry()).status).toBe(202);
      const claimed = await worker('claim', { workerId: W1 });
      expect(claimed.body).toMatchObject({ runId, kind: 'deliver', studioPaths: ['.env'] });
      expect(claimed.body).not.toHaveProperty('environmentFile');
      expectNoContent(claimed);
      expect(
        (
          await worker(`${runId}/state`, {
            workerId: W1,
            state: 'failed',
            failure: { code: 'delivery_failed', detail: `push of ${PASSWORD_VALUE} refused` },
            workingCopy: workingCopy(`agent: used ${KEY_VALUE}`),
          })
        ).status,
      ).toBe(204);

      const run = await http().get(`/api/runs/${runId}`).set('Cookie', cookie);
      expectNoContent(run);
      expect(run.body.failure.detail).toBe(`push of ${REDACTED} refused`);
      expect(run.body.commits[0].subject).toBe(`agent: used ${REDACTED}`);
      expect(await snapshotCount()).toBe(1);

      expect((await retry()).status).toBe(202);
      expect((await worker('claim', { workerId: W1 })).body.kind).toBe('deliver');
      expect(
        (
          await worker(`${runId}/state`, {
            workerId: W1,
            state: 'succeeded',
            delivery: { outcome: 'none' },
            workingCopy: workingCopy('Add a feature'),
          })
        ).status,
      ).toBe(204);
      expect(await snapshotCount()).toBe(0);
    });

    it("redacts the file's values from the log and step results, and deletes the snapshot once final", async () => {
      const projectId = await readyProject();
      await put(projectId, { path: '.env', content: CONTENT });
      const runId = await startRun(projectId);
      await worker('claim', { workerId: W1 });
      await worker(`${runId}/state`, { workerId: W1, state: 'running' });
      expect(await snapshotCount()).toBe(1);

      const appended = await worker(`${runId}/events`, {
        workerId: W1,
        events: [
          { seq: 1, at: new Date().toISOString(), stepIndex: 1, kind: 'command', text: 'cat .env' },
          { seq: 2, at: new Date().toISOString(), stepIndex: 1, kind: 'output', text: CONTENT },
        ],
      });
      expect(appended.status).toBe(204);
      const step = await worker(`${runId}/steps`, {
        workerId: W1,
        index: 1,
        kind: 'start',
        result: {
          outcome: 'done',
          summary: `Used ${KEY_VALUE}`,
          checks: [{ name: 'login', result: 'passed', detail: `pw ${PASSWORD_VALUE}` }],
        },
        workingCopy: { runBranch: 'agent/x-r0b8e5c2d', commits: [], hasUncommittedChanges: false },
      });
      expect(step.status).toBe(204);
      expect(
        (
          await worker(`${runId}/state`, {
            workerId: W1,
            state: 'succeeded',
            delivery: { outcome: 'none' },
          })
        ).status,
      ).toBe(204);

      const events = await http().get(`/api/runs/${runId}/events`).set('Cookie', cookie);
      const steps = await http().get(`/api/runs/${runId}/steps`).set('Cookie', cookie);
      const stream = await http().get(`/api/runs/${runId}/events/stream`).set('Cookie', cookie);
      for (const response of [events, steps, stream]) expectNoContent(response);
      expect(events.body.events[1].text).toContain(`DB_PASSWORD=${REDACTED}`);
      expect(steps.body.steps[0]).toMatchObject({ outcome: 'done', summary: `Used ${REDACTED}` });
      const stored = await db().$queryRaw<{ text: string }[]>`
        SELECT text FROM run_events WHERE run_id = ${runId}::uuid
        UNION ALL SELECT result::text FROM run_steps WHERE run_id = ${runId}::uuid`;
      expect(stored.map((row) => row.text).join('\n')).not.toMatch(
        new RegExp(`${PASSWORD_VALUE}|${KEY_VALUE}`),
      );
      expect(await snapshotCount()).toBe(0);
      expect((await get(projectId)).body).toMatchObject({ path: '.env' });
    });
  });
});
