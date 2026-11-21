import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// A Run's merge review over HTTP on the real app (PostgreSQL and Redis via Testcontainers) and
// the real `git` against a `file://` remote, so Linux only: the pull request is a record the
// worker's routes reported, and the review is computed by Studio's own fetch and merge.

// Throwaway values generated per run; none is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const KNOWN_SECRET = `env-value-${randomBytes(6).toString('hex')}`;
const REDACTED = '••••••[redacted]';
const PROBLEM = 'urn:agentic-studio:problem:';
const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
const linux = process.platform === 'linux';

function expectProblem(response: request.Response, status: number, type: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
  expect(response.body.type).toBe(`${PROBLEM}${type}`);
}

describe.runIf(linux)('merge review API (PostgreSQL + Redis via Testcontainers, real git)', () => {
  let services: StudioServices;
  let root: string;
  let app: INestApplication;
  let cookie: string;
  let fixtureNumber = 0;
  const worker = randomUUID();

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const asWorker = (path: string, body: object) =>
    http().post(`/api/worker/${path}`).set('Authorization', `Bearer ${WORKER_TOKEN}`).send(body);
  const operator = (call: request.Test) => call.set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
  const requestReview = (runId: string) => operator(http().post(`/api/runs/${runId}/merge-review`));
  const readReview = (runId: string) =>
    http().get(`/api/runs/${runId}/merge-review`).set('Cookie', cookie);
  const readFile = (runId: string, path: string) =>
    http().get(`/api/runs/${runId}/merge-review/file`).query({ path }).set('Cookie', cookie);

  async function restart(options: Parameters<typeof startStudioApp>[1] = {}) {
    await app.close();
    app = await startStudioApp(services.config, {
      executions: { secretValues: { forRun: () => Promise.resolve([KNOWN_SECRET]) } },
      ...options,
    });
    cookie = await signIn(app);
  }

  async function settled(path: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await http().get(path).set('Cookie', cookie);
      expect(response.status).toBe(200);
      if (!['connecting', 'fetching', 'preparing'].includes(response.body.state)) {
        return response.body;
      }
      if (Date.now() > deadline) throw new Error(`still ${response.body.state}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** A project whose Repository is connected to a fresh fixture remote and ready. */
  async function readyProject(): Promise<{ projectId: string; fixture: GitFixture }> {
    const fixture = createGitFixture(root, `shop-${fixtureNumber++}`);
    const created = await operator(http().post('/api/projects')).send({
      name: `Shop ${randomUUID()}`,
    });
    expect(created.status).toBe(201);
    const projectId = created.body.id as string;
    const connected = await operator(http().post(`/api/projects/${projectId}/repository`)).send({
      url: fixture.url,
      integrationBranch: 'dev',
    });
    expect(connected.status).toBe(201);
    expect((await settled(`/api/projects/${projectId}/repository`)).state).toBe('ready');
    return { projectId, fixture };
  }

  /** A Run of the project carried by the worker to its pull request; the branch is not pushed. */
  async function deliveredRun(
    projectId: string,
    options: { delivered?: boolean } = {},
  ): Promise<{ runId: string; runBranch: string }> {
    const started = await operator(http().post(`/api/projects/${projectId}/runs`)).send({
      task: 'Add a health check',
      provider: 'codex',
    });
    expect(started.status).toBe(201);
    const runId = started.body.id as string;
    const runBranch = `agent/add-a-health-check-r${runId.slice(0, 8)}`;
    expect((await asWorker('runs/claim', { workerId: worker })).status).toBe(200);
    await asWorker(`runs/${runId}/state`, { workerId: worker, state: 'running' });
    const stepped = await asWorker(`runs/${runId}/steps`, {
      workerId: worker,
      index: 1,
      kind: 'start',
      result: { outcome: 'done', summary: 'Done.', sessionRef: 'session-1' },
      workingCopy: {
        runBranch,
        commits: [{ id: 'c'.repeat(40), subject: 'Add GET /health' }],
        hasUncommittedChanges: false,
      },
    });
    expect(stepped.status).toBe(204);
    const ended = await asWorker(`runs/${runId}/state`, {
      workerId: worker,
      state: 'succeeded',
      delivery:
        options.delivered === false
          ? { outcome: 'none' }
          : { outcome: 'delivered', pullRequest: PULL_REQUEST },
    });
    expect(ended.status).toBe(204);
    return { runId, runBranch };
  }

  beforeAll(async () => {
    services = await startStudioServices();
    root = await mkdtemp(join(tmpdir(), 'studio-review-http-'));
    await mkdir(join(root, 'data'));
    services.config = {
      ...services.config,
      dataDir: join(root, 'data'),
      workerToken: WORKER_TOKEN_DIGEST,
      gitAllowFileRemotes: true,
      gitAllowPrivateRemotes: true,
    };
    app = await startStudioApp(services.config, {
      executions: { secretValues: { forRun: () => Promise.resolve([KNOWN_SECRET]) } },
    });
    cookie = await signIn(app);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    const status = await asWorker('status', {
      workerId: worker,
      runner: 'cli',
      providers: { claude_code: true, codex: true },
    });
    expect(status.status).toBe(204);
  });

  it('prepares the review in the background: the files Studio computed, redacted, one patch each', async () => {
    const { projectId, fixture } = await readyProject();
    const { runId, runBranch } = await deliveredRun(projectId);
    const runCommit = pushFiles(fixture, runBranch, 'dev', {
      'src/app.ts': 'export const app = 1;\n',
      'config.txt': `token=${KNOWN_SECRET}\n`,
    });
    expect((await readReview(runId)).body).toEqual({ state: 'none', files: [], truncated: false });

    const accepted = await requestReview(runId);
    expect(accepted.status).toBe(202);
    const review = await settled(`/api/runs/${runId}/merge-review`);

    expect(review).toEqual({
      state: 'ready',
      runCommit,
      integrationCommit: fixture.commits.dev,
      files: [
        { path: 'config.txt', status: 'added', cut: false },
        { path: 'src/app.ts', status: 'added', cut: false },
      ],
      truncated: false,
    });
    const config = await readFile(runId, 'config.txt');
    expect(config.status).toBe(200);
    expect(config.body.patch).toContain(`+token=${REDACTED}`);
    expect(config.body.patch).not.toContain(KNOWN_SECRET);
    expect((await readFile(runId, 'src/app.ts')).body.patch).toContain('+export const app = 1;');
    const [stored] = await db().$queryRaw<{ files: string }[]>`
      SELECT files::text AS files FROM run_merge_reviews WHERE run_id = ${runId}::uuid`;
    expect(stored!.files).not.toContain(KNOWN_SECRET);
    expectProblem(await readFile(runId, 'nope.txt'), 404, 'merge-review-file-not-found');
  });

  it('reads the review as out of date once the Run branch has another commit', async () => {
    const { projectId, fixture } = await readyProject();
    const { runId, runBranch } = await deliveredRun(projectId);
    pushFiles(fixture, runBranch, 'dev', { 'a.txt': 'a\n' });
    expect((await requestReview(runId)).status).toBe(202);
    expect((await settled(`/api/runs/${runId}/merge-review`)).state).toBe('ready');

    await db().$executeRaw`
      UPDATE runs SET pushed_commit = ${'d'.repeat(40)} WHERE id = ${runId}::uuid`;

    expect((await readReview(runId)).body.state).toBe('out_of_date');
  });

  it('stores a conflict with the Integration branch as a failed review', async () => {
    const { projectId, fixture } = await readyProject();
    const { runId, runBranch } = await deliveredRun(projectId);
    pushFiles(fixture, runBranch, 'dev', { 'README.md': '# run\n' });
    pushFiles(fixture, 'dev', 'dev', { 'README.md': '# integration\n' });

    expect((await requestReview(runId)).status).toBe(202);
    const review = await settled(`/api/runs/${runId}/merge-review`);

    expect(review).toMatchObject({
      state: 'failed',
      failure: 'The Run branch conflicts with the Integration branch.',
      files: [],
    });
  });

  it('fails a review whose Run branch is gone from the Git host', async () => {
    const { projectId } = await readyProject();
    const { runId } = await deliveredRun(projectId);

    expect((await requestReview(runId)).status).toBe(202);
    const review = await settled(`/api/runs/${runId}/merge-review`);

    expect(review).toMatchObject({ state: 'failed' });
    expect(review.failure).toMatch(/Run branch no longer exists/);
  });

  describe('refusals (409, each with its own problem type)', () => {
    it('no_pull_request: the Run opened none', async () => {
      const { projectId } = await readyProject();
      const { runId } = await deliveredRun(projectId, { delivered: false });

      expectProblem(await requestReview(runId), 409, 'no-pull-request');
    });

    it.each(['merged', 'closed', 'missing'])(
      'pull_request_not_open: the pull request is %s',
      async (state) => {
        const { projectId } = await readyProject();
        const { runId } = await deliveredRun(projectId);
        await db().$executeRaw`
          UPDATE runs SET pr_state = ${state}, pr_refreshed_at = now(), pr_ended_at = now()
          WHERE id = ${runId}::uuid`;

        expectProblem(await requestReview(runId), 409, 'pull-request-not-open');
      },
    );

    it('accepts a draft pull request', async () => {
      const { projectId, fixture } = await readyProject();
      const { runId, runBranch } = await deliveredRun(projectId);
      pushFiles(fixture, runBranch, 'dev', { 'a.txt': 'a\n' });
      await db().$executeRaw`
        UPDATE runs SET pr_state = 'draft', pr_refreshed_at = now() WHERE id = ${runId}::uuid`;

      expect((await requestReview(runId)).status).toBe(202);
      expect((await settled(`/api/runs/${runId}/merge-review`)).state).toBe('ready');
    });

    it('repository_not_ready: the Project has no ready Repository', async () => {
      const { projectId } = await readyProject();
      const { runId } = await deliveredRun(projectId);
      await db().$executeRaw`DELETE FROM repositories WHERE project_id = ${projectId}::uuid`;

      expectProblem(await requestReview(runId), 409, 'repository-not-ready');
    });

    it('review_in_progress: a review is being prepared; a stale one can be replaced', async () => {
      const { projectId, fixture } = await readyProject();
      const { runId, runBranch } = await deliveredRun(projectId);
      pushFiles(fixture, runBranch, 'dev', { 'a.txt': 'a\n' });
      await db().$executeRaw`
        INSERT INTO run_merge_reviews (run_id, state, files, truncated, requested_at)
        VALUES (${runId}::uuid, 'preparing', '[]'::jsonb, false, now())`;

      expectProblem(await requestReview(runId), 409, 'review-in-progress');
      expect((await readReview(runId)).body.state).toBe('preparing');

      await db().$executeRaw`
        UPDATE run_merge_reviews SET requested_at = now() - interval '16 minutes'
        WHERE run_id = ${runId}::uuid`;
      const lost = await readReview(runId);
      expect(lost.body).toMatchObject({ state: 'failed' });
      expect(lost.body.failure).toMatch(/interrupted/);

      expect((await requestReview(runId)).status).toBe(202);
      expect((await settled(`/api/runs/${runId}/merge-review`)).state).toBe('ready');
    });

    it('unsupported_platform: the API does not run on Linux', async () => {
      const { projectId } = await readyProject();
      const { runId } = await deliveredRun(projectId);
      await restart({ projects: { gitSettings: { platform: 'win32' } } });

      try {
        expectProblem(await requestReview(runId), 409, 'unsupported-platform');
      } finally {
        await restart();
      }
    });
  });

  describe('operator routes only', () => {
    it('are not reachable with the worker token, and need the session', async () => {
      const { projectId } = await readyProject();
      const { runId } = await deliveredRun(projectId);
      const bearer = { Authorization: `Bearer ${WORKER_TOKEN}`, Origin: STUDIO_ORIGIN };

      expect((await http().post(`/api/runs/${runId}/merge-review`).set(bearer)).status).toBe(401);
      expect((await http().get(`/api/runs/${runId}/merge-review`).set(bearer)).status).toBe(401);
      expect(
        (await http().get(`/api/runs/${runId}/merge-review/file`).query({ path: 'a' }).set(bearer))
          .status,
      ).toBe(401);
      expect((await http().get(`/api/runs/${runId}/merge-review`)).status).toBe(401);
    });

    it('names an unknown Run 404', async () => {
      const unknown = randomUUID();

      expectProblem(await requestReview(unknown), 404, 'run-not-found');
      expectProblem(await readReview(unknown), 404, 'run-not-found');
      expectProblem(await readFile(unknown, 'a'), 404, 'run-not-found');
    });
  });
});
