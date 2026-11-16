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

// Issue #144, main seam: a Run's diffs over HTTP on the real app with PostgreSQL and Redis from
// Testcontainers. The worker reports them over its route exactly as the agent worker does; the
// operator reads the file list and then each file's patch.

// Throwaway values generated per run; none is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
/** A known secret value of every Run in this suite (the #104 hook, through the test seam). */
const KNOWN_SECRET = `env-value-${randomBytes(6).toString('hex')}`;
const REDACTED = '••••••[redacted]';
const RUN_NOT_HELD = 'urn:agentic-studio:problem:run-not-held';
const RUN_NOT_FOUND = 'urn:agentic-studio:problem:run-not-found';
const DIFF_NOT_FOUND = 'urn:agentic-studio:problem:run-diff-not-found';
const FILE_NOT_FOUND = 'urn:agentic-studio:problem:run-diff-file-not-found';

function expectProblem(response: request.Response, status: number, type?: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
  if (type) expect(response.body.type).toBe(type);
}

describe('Run diff API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  let cookie: string;
  let startCommit: string;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const W1 = randomUUID();
  const W2 = randomUUID();

  const report = (
    runId: string,
    body: object,
    workerId = W1,
    token: string | null = WORKER_TOKEN,
  ) => {
    const call = http().post(`/api/worker/runs/${runId}/diff`);
    if (token !== null) call.set('Authorization', `Bearer ${token}`);
    return call.send({ workerId, ...body });
  };
  const readDiff = (runId: string, query: string) =>
    http().get(`/api/runs/${runId}/diff${query}`).set('Cookie', cookie);

  const diffOf = (files: object[], overrides: object = {}) => ({
    baseCommit: startCommit,
    includesUnpushed: true,
    truncated: false,
    files,
    ...overrides,
  });

  /** A Run claimed by W1 and running (test setup: a project with a ready Repository). */
  async function runningRun(): Promise<string> {
    const name = `Project ${randomUUID()}`;
    const [project] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    const path = `git.example.test/acme/${project!.id}`;
    startCommit = randomBytes(20).toString('hex');
    await db().$executeRaw`
      INSERT INTO repositories
        (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
      VALUES (${project!.id}::uuid, ${`https://${path}.git`}, ${path}, 'dev', 'ready',
              ${startCommit}, now())`;
    const started = await http()
      .post(`/api/projects/${project!.id}/runs`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send({ task: 'Add a health check', provider: 'codex' });
    expect(started.status).toBe(201);
    const claimed = await http()
      .post('/api/worker/runs/claim')
      .set('Authorization', `Bearer ${WORKER_TOKEN}`)
      .send({ workerId: W1 });
    expect(claimed.body.runId).toBe(started.body.id);
    const running = await http()
      .post(`/api/worker/runs/${started.body.id}/state`)
      .set('Authorization', `Bearer ${WORKER_TOKEN}`)
      .send({ workerId: W1, state: 'running' });
    expect(running.status).toBe(204);
    return started.body.id as string;
  }

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(
      { ...services.config, workerToken: WORKER_TOKEN_DIGEST },
      { executions: { secretValues: { forRun: () => Promise.resolve([KNOWN_SECRET]) } } },
    );
    cookie = await signIn(app);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  beforeEach(async () => {
    // Test isolation only; CASCADE also empties runs, run_diffs and run_diff_files.
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    const status = await http()
      .post('/api/worker/status')
      .set('Authorization', `Bearer ${WORKER_TOKEN}`)
      .send({ workerId: W1, runner: 'cli', providers: { claude_code: true, codex: true } });
    expect(status.status).toBe(204);
  });

  it('stores both diffs; the operator reads the file list, then each file by path', async () => {
    const runId = await runningRun();
    const patch = 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1,2 @@\n-a\n+b\n+c\n';
    const files = [
      { path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1, patch },
      {
        path: 'src/new.ts',
        previousPath: 'src/old.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        patch: 'diff --git a/src/old.ts b/src/new.ts\nsimilarity index 100%\n',
      },
      { path: 'logo.png', status: 'added', additions: 0, deletions: 0, binary: true },
      { path: 'big.json', status: 'added', additions: 9000, deletions: 0, tooLarge: true },
      { path: 'later.ts', status: 'added', additions: 1, deletions: 0 },
    ];

    expect(
      (
        await report(runId, {
          run: diffOf(files, { truncated: true }),
          last: diffOf(files.slice(0, 1)),
        })
      ).status,
    ).toBe(204);

    const whole = await readDiff(runId, '?scope=run');
    expect(whole.status).toBe(200);
    expect(whole.body).toEqual({
      scope: 'run',
      baseCommit: startCommit,
      includesUnpushed: true,
      truncated: true,
      files: files.map((entry) => {
        const { patch, ...file } = entry;
        void patch;
        return file;
      }),
    });
    const last = await readDiff(runId, '?scope=last');
    expect(last.body.files.map((file: { path: string }) => file.path)).toEqual(['src/app.ts']);

    const file = await readDiff(runId, `/file?scope=run&path=${encodeURIComponent('src/app.ts')}`);
    expect(file.status).toBe(200);
    expect(file.body).toEqual({ path: 'src/app.ts', status: 'modified', patch });
    const renamed = await readDiff(runId, '/file?scope=run&path=src/new.ts');
    expect(renamed.body).toMatchObject({ previousPath: 'src/old.ts', status: 'renamed' });
    expect((await readDiff(runId, '/file?scope=run&path=logo.png')).body).toEqual({
      path: 'logo.png',
      status: 'added',
      binary: true,
    });
    expect((await readDiff(runId, '/file?scope=run&path=big.json')).body).toEqual({
      path: 'big.json',
      status: 'added',
      tooLarge: true,
    });
    expect((await readDiff(runId, '/file?scope=run&path=later.ts')).body).toEqual({
      path: 'later.ts',
      status: 'added',
    });
    expectProblem(await readDiff(runId, '/file?scope=last&path=logo.png'), 404, FILE_NOT_FOUND);
  });

  it('redacts a known value and token-shaped strings in the patches before storing them', async () => {
    const runId = await runningRun();
    const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
    const patch = `@@ -0,0 +1,2 @@\n+PASSWORD=${KNOWN_SECRET}\n+TOKEN=${token}\n`;
    const files = [{ path: 'conf.ts', status: 'added', additions: 2, deletions: 0, patch }];

    expect((await report(runId, { run: diffOf(files), last: diffOf(files) })).status).toBe(204);

    const file = await readDiff(runId, '/file?scope=run&path=conf.ts');
    expect(file.body.patch).toBe(`@@ -0,0 +1,2 @@\n+PASSWORD=${REDACTED}\n+TOKEN=${REDACTED}\n`);
    const [stored] = await db().$queryRaw<{ patch: string }[]>`
      SELECT patch FROM run_diff_files WHERE run_id = ${runId}::uuid AND scope = 'last'`;
    expect(stored?.patch).not.toContain(KNOWN_SECRET);
    expect(stored?.patch).not.toContain(token);
  });

  it('replaces the stored diffs with each report, and keeps them after the Run is final', async () => {
    const runId = await runningRun();
    const first = [{ path: 'a.ts', status: 'added', additions: 1, deletions: 0, patch: '+a\n' }];
    const second = [{ path: 'b.ts', status: 'added', additions: 1, deletions: 0, patch: '+b\n' }];
    await report(runId, { run: diffOf(first), last: diffOf(first) });
    await report(runId, { run: diffOf(second), last: diffOf(second) });

    const finished = await http()
      .post(`/api/worker/runs/${runId}/state`)
      .set('Authorization', `Bearer ${WORKER_TOKEN}`)
      .send({ workerId: W1, state: 'succeeded', delivery: { outcome: 'none' } });
    expect(finished.status).toBe(204);

    const whole = await readDiff(runId, '?scope=run');
    expect(whole.body.files.map((file: { path: string }) => file.path)).toEqual(['b.ts']);
    expectProblem(await readDiff(runId, '/file?scope=run&path=a.ts'), 404, FILE_NOT_FOUND);
    // Once final, the Run is no longer held: no report changes its diffs.
    expectProblem(
      await report(runId, { run: diffOf(first), last: diffOf(first) }),
      409,
      RUN_NOT_HELD,
    );
  });

  it('stores why the diffs could not be computed', async () => {
    const runId = await runningRun();

    expect(
      (await report(runId, { unavailable: 'The changes could not be computed.' })).status,
    ).toBe(204);

    expect((await readDiff(runId, '?scope=last')).body).toEqual({
      scope: 'last',
      includesUnpushed: false,
      truncated: false,
      files: [],
      unavailableReason: 'The changes could not be computed.',
    });
  });

  it('says when a Run has no diff yet, and when the Run is unknown', async () => {
    const runId = await runningRun();

    expectProblem(await readDiff(runId, '?scope=run'), 404, DIFF_NOT_FOUND);
    expectProblem(await readDiff(randomUUID(), '?scope=run'), 404, RUN_NOT_FOUND);
    expectProblem(await readDiff(runId, '?scope=all'), 400);
    expectProblem(await readDiff(runId, '/file?scope=run'), 400);
  });

  it('requires the worker token and the holding worker for reporting', async () => {
    const runId = await runningRun();
    const diff = diffOf([]);

    expectProblem(await report(runId, { run: diff, last: diff }, W1, null), 401);
    expectProblem(
      await report(runId, { run: diff, last: diff }, W1, randomBytes(32).toString('base64')),
      401,
    );
    expectProblem(await report(runId, { run: diff, last: diff }, W2), 409, RUN_NOT_HELD);
    expectProblem(await report(randomUUID(), { run: diff, last: diff }), 404, RUN_NOT_FOUND);
    expectProblem(await report(runId, { run: diff }), 400);
  });

  it('takes a large report only with the worker token', async () => {
    const runId = await runningRun();
    // About 1 MiB of patches: over every other route's limit, within the diff route's.
    const files = Array.from({ length: 4 }, (_, i) => ({
      path: `f${i}.txt`,
      status: 'added',
      additions: 1,
      deletions: 0,
      patch: `+${'x'.repeat(250_000)}\n`,
    }));
    const body = { run: diffOf(files), last: diffOf(files) };

    expect((await report(runId, body)).status).toBe(204);
    expect((await report(runId, body, W1, randomBytes(32).toString('base64'))).status).toBe(413);
  });

  it('rejects reading diffs without a session', async () => {
    const runId = await runningRun();

    expectProblem(await http().get(`/api/runs/${runId}/diff?scope=run`), 401);
    expectProblem(await http().get(`/api/runs/${runId}/diff/file?scope=run&path=a.ts`), 401);
  });
});
