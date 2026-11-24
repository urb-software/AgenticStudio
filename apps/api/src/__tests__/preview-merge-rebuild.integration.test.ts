import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewSchema } from '@agentic-studio/contracts';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MERGED_RUN_PREVIEWS,
  type MergedRunPreviews,
} from '../modules/environments/contracts/index.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { createGitFixture, type GitFixture, pushFiles } from './git-fixture.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// A merge through Studio asks the Preview for a rebuild, on the real app (PostgreSQL and Redis via
// Testcontainers). The cases that read the Compose file and fetch need the real `git`: Linux only.

// Throwaway tokens generated per run; none is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const CONTROLLER_TOKEN = randomBytes(32).toString('base64');
const digest = (token: string) => createSecretKey(createHash('sha256').update(token).digest());
const CONTROLLER = randomUUID();
const linux = process.platform === 'linux';
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\n';
const SETTINGS = { composeFile: 'compose.yaml', service: 'web', port: 80 };
const RUNNING = { services: [{ name: 'web', state: 'running' }] };

describe('the Preview rebuild after a merge (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let dataDir: string;
  let app: INestApplication;
  let cookie: string;
  let fixture: GitFixture;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const session = () => ({ Origin: STUDIO_ORIGIN, Cookie: cookie });
  const controllerAuth = { Authorization: `Bearer ${CONTROLLER_TOKEN}` };
  const base = '/api/controller/operations';
  const previewUrl = (projectId: string) => `/api/projects/${projectId}/preview`;
  const previews = () => app.get<MergedRunPreviews>(MERGED_RUN_PREVIEWS, { strict: false });
  /** Long enough for several releases of the 250 ms timer, so a rebuild that should wait is seen waiting. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1200));
  const buildCount = async (projectId: string, count: number) =>
    until(
      async () => (await builds(projectId)).length,
      (found) => found >= count,
    );
  const getPreview = async (projectId: string) => {
    const response = await http().get(previewUrl(projectId)).set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(previewSchema.safeParse(response.body).success).toBe(true);
    return response.body;
  };
  const claim = () =>
    http().post(`${base}/claim`).set(controllerAuth).send({ controllerId: CONTROLLER });
  const report = (id: string, body: object) =>
    http()
      .post(`${base}/${id}/state`)
      .set(controllerAuth)
      .send({ controllerId: CONTROLLER, ...body });
  const builds = (projectId: string) =>
    db().previewOperation.findMany({
      where: { projectId, kind: 'build' },
      orderBy: { requestedAt: 'asc' },
    });

  async function createProject(): Promise<string> {
    const response = await http()
      .post('/api/projects')
      .set(session())
      .send({ name: `Project ${randomUUID()}` });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out; last: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function readyProject(): Promise<string> {
    const projectId = await createProject();
    const connected = await http()
      .post(`/api/projects/${projectId}/repository`)
      .set(session())
      .send({ url: fixture.url, integrationBranch: 'dev' });
    expect(connected.status).toBe(201);
    await until(
      async () =>
        (await http().get(`/api/projects/${projectId}/repository`).set('Cookie', cookie)).body
          .state as string,
      (state) => {
        if (state === 'failed') throw new Error('the repository failed');
        return state === 'ready';
      },
    );
    const saved = await http()
      .put(`${previewUrl(projectId)}/settings`)
      .set(session())
      .send(SETTINGS);
    expect(saved.status).toBe(200);
    expect((await claim()).status).toBe(204);
    return projectId;
  }

  const headOf = async (projectId: string): Promise<string> =>
    (await getPreview(projectId)).repository.commit as string;

  /** Builds and runs the Preview at the Clone's commit. */
  async function runningPreview(projectId: string): Promise<string> {
    const queued = await http()
      .post(`${previewUrl(projectId)}/builds`)
      .set(session());
    expect(queued.status).toBe(202);
    const claimed = await claim();
    expect(claimed.body.operationId).toBe(queued.body.id);
    await report(queued.body.id as string, { state: 'succeeded', runtime: RUNNING });
    expect((await getPreview(projectId)).state).toBe('running');
    return queued.body.id as string;
  }

  /** The head of the fixture's Integration branch; every case starts from a valid Compose file. */
  let devHead = '';

  /** A commit on the fixture's Integration branch, as a merge on the Git host makes. */
  function mergeOnHost(): string {
    devHead = pushFiles(fixture, 'dev', devHead, {
      'compose.yaml': COMPOSE,
      [`merged-${randomUUID()}.txt`]: 'merged\n',
    });
    return devHead;
  }

  async function fetchClone(projectId: string, commit: string): Promise<void> {
    const fetched = await http().post(`/api/projects/${projectId}/repository/fetch`).set(session());
    expect(fetched.status).toBe(202);
    await until(
      async () =>
        (await http().get(`/api/projects/${projectId}/preview`).set('Cookie', cookie)).body
          .repository?.commit as string | undefined,
      (head) => head === commit,
    );
  }

  const mergedAtOf = new Map<string, Date>();
  const merge = (projectId: string, runId: string, mergedCommit: string) => {
    const mergedAt = new Date();
    mergedAtOf.set(runId, mergedAt);
    return { projectId, runId, mergedCommit, mergedAt, fetchStartedAt: new Date() };
  };
  const stateOf = async (projectId: string, runId: string, mergedCommit: string) =>
    (await previews().forMerge(projectId, runId, mergedCommit, mergedAtOf.get(runId) ?? new Date()))
      .state;

  beforeAll(async () => {
    services = await startStudioServices();
    dataDir = await mkdtemp(join(tmpdir(), 'studio-preview-merge-rebuild-http-'));
    services.config = {
      ...services.config,
      dataDir,
      gitAllowFileRemotes: true,
      gitAllowPrivateRemotes: true,
      workerToken: digest(WORKER_TOKEN),
      controllerToken: digest(CONTROLLER_TOKEN),
      controllerLeaseSeconds: 60,
      previewDomain: 'preview.example.test',
    };
    if (linux) {
      fixture = createGitFixture(dataDir, 'preview-merge-rebuild-source', {
        branches: ['main', 'dev'],
      });
      devHead = pushFiles(fixture, 'dev', fixture.commits.dev!, { 'compose.yaml': COMPOSE });
    }
    app = await startStudioApp(services.config, {
      environments: { sweeps: false, mergeRebuilds: { enabled: true, intervalMs: 250 } },
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
    if (linux) devHead = pushFiles(fixture, 'dev', devHead, { 'compose.yaml': COMPOSE });
  });

  describe('what the merge asks of the Preview', () => {
    it('never throws, whatever the Preview cannot do', async () => {
      await expect(
        previews().merged(merge('not-a-uuid', randomUUID(), 'e'.repeat(40))),
      ).resolves.toBeUndefined();
      await expect(
        previews().merged(merge(randomUUID(), randomUUID(), 'e'.repeat(40))),
      ).resolves.toBeUndefined();
      expect(await db().previewMergeRebuild.count()).toBe(0);
    });

    it('says not_configured for a Project without Preview settings', async () => {
      const id = await createProject();

      await expect(
        previews().forMerge(id, randomUUID(), 'e'.repeat(40), new Date()),
      ).resolves.toEqual({
        state: 'not_configured',
      });
    });
  });

  describe.runIf(linux)('with a ready Repository (real git)', () => {
    it('rebuilds a running Preview once the Clone holds the merge: one build, started by the Run', async () => {
      const id = await readyProject();
      const first = await runningPreview(id);
      const runId = randomUUID();
      const merged = mergeOnHost();

      await previews().merged(merge(id, runId, merged));

      const waiting = await getPreview(id);
      expect(waiting.mergeRebuild).toMatchObject({
        runId,
        status: 'waiting',
        reason: 'the Clone fetch',
      });
      expect(waiting.behind).toBe(false);
      expect(await stateOf(id, runId, merged)).toBe('waiting');
      await settle();
      expect(await builds(id)).toHaveLength(1);

      await fetchClone(id, merged);
      expect((await getPreview(id)).behind).toBe(true);
      await buildCount(id, 2);

      const rows = await builds(id);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ commit: merged, startedByRunId: runId, status: 'requested' });
      expect(rows[0]!.id).toBe(first);
      const building = await getPreview(id);
      expect(building.latestBuild).toMatchObject({
        status: 'queued',
        startedBy: { kind: 'merge', runId },
      });
      expect(building.mergeRebuild).toBeNull();
      expect(await stateOf(id, runId, merged)).toBe('building');

      const claimed = await claim();
      expect(claimed.body.operationId).toBe(rows[1]!.id);
      await report(rows[1]!.id, { state: 'succeeded', runtime: RUNNING });
      const after = await getPreview(id);
      expect(after).toMatchObject({
        state: 'running',
        behind: false,
        running: { buildId: rows[1]!.id, commit: merged },
      });
      expect(await stateOf(id, runId, merged)).toBe('running');
      await settle();
      expect(await builds(id)).toHaveLength(2);
    });

    it('starts nothing for a stopped Preview: no row, no build, and the page says it is behind', async () => {
      const id = await readyProject();
      await runningPreview(id);
      const stop = await http()
        .post(`${previewUrl(id)}/stop`)
        .set(session());
      expect(stop.status).toBe(202);
      const claimedStop = await claim();
      await report(claimedStop.body.operationId as string, { state: 'succeeded' });
      expect((await getPreview(id)).state).toBe('stopped');
      const runId = randomUUID();
      const merged = mergeOnHost();

      await previews().merged(merge(id, runId, merged));
      await fetchClone(id, merged);
      await settle();

      expect(await db().previewMergeRebuild.count()).toBe(0);
      expect(await builds(id)).toHaveLength(1);
      expect(await getPreview(id)).toMatchObject({ state: 'stopped', behind: true });
      expect(await stateOf(id, runId, merged)).toBe('not_started');
    });

    it('waits for a build under way, then builds the Clone head', async () => {
      const id = await readyProject();
      await runningPreview(id);
      const queued = await http()
        .post(`${previewUrl(id)}/builds`)
        .set(session());
      expect(queued.status).toBe(202);
      const claimed = await claim();
      expect(claimed.body.operationId).toBe(queued.body.id);
      const runId = randomUUID();
      const merged = mergeOnHost();
      await fetchClone(id, merged);

      await previews().merged(merge(id, runId, merged));
      await settle();

      expect(await db().previewMergeRebuild.count()).toBe(1);
      expect(await builds(id)).toHaveLength(2);
      expect((await getPreview(id)).mergeRebuild).toMatchObject({
        status: 'waiting',
        reason: 'the current build',
      });

      await report(queued.body.id as string, { state: 'succeeded', runtime: RUNNING });
      await buildCount(id, 3);

      const rows = await builds(id);
      expect(rows).toHaveLength(3);
      expect(rows[2]).toMatchObject({ commit: merged, startedByRunId: runId });
      expect(await db().previewMergeRebuild.count()).toBe(0);
    });

    it('keeps one waiting rebuild and makes one build for three merges in a row', async () => {
      const id = await readyProject();
      await runningPreview(id);
      const runs = [randomUUID(), randomUUID(), randomUUID()];
      const commits = runs.map(() => mergeOnHost());

      for (const [index, runId] of runs.entries()) {
        await previews().merged(merge(id, runId, commits[index]!));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const stored = await db().previewMergeRebuild.findMany({ where: { projectId: id } });
      expect(stored).toHaveLength(1);
      expect(stored[0]!.runId).toBe(runs[2]);
      expect(await stateOf(id, runs[0]!, commits[0]!)).toBe('replaced');
      await fetchClone(id, commits[2]!);
      await buildCount(id, 2);
      await settle();

      const rows = await builds(id);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ commit: commits[2], startedByRunId: runs[2] });
      expect(await db().previewMergeRebuild.count()).toBe(0);

      const claimed = await claim();
      await report(claimed.body.operationId as string, { state: 'succeeded', runtime: RUNNING });
      expect(await stateOf(id, runs[0]!, commits[0]!)).toBe('replaced');
      expect(await stateOf(id, runs[1]!, commits[1]!)).toBe('replaced');
      expect(await stateOf(id, runs[2]!, commits[2]!)).toBe('running');
    });

    it('drops the rebuild when the Preview already runs the Clone commit', async () => {
      const id = await readyProject();
      await runningPreview(id);
      const head = await headOf(id);

      await previews().merged(merge(id, randomUUID(), head));
      await until(
        () => db().previewMergeRebuild.count(),
        (count) => count === 0,
      );

      expect(await db().previewMergeRebuild.count()).toBe(0);
      expect(await builds(id)).toHaveLength(1);
    });

    it('removes the waiting rebuild with the Project', async () => {
      const id = await readyProject();
      await runningPreview(id);
      await previews().merged(merge(id, randomUUID(), mergeOnHost()));
      expect(await db().previewMergeRebuild.count()).toBe(1);

      await db().project.delete({ where: { id } });

      expect(await db().previewMergeRebuild.count()).toBe(0);
    });

    it('fails the rebuild at once when the Compose file is refused at the merged commit', async () => {
      const id = await readyProject();
      await runningPreview(id);
      const runId = randomUUID();
      const merged = (devHead = pushFiles(fixture, 'dev', devHead, {
        'compose.yaml': 'services:\n  web:\n    image: nginx:1.27\n    privileged: true\n',
      }));
      await previews().merged(merge(id, runId, merged));
      await fetchClone(id, merged);
      await until(
        () => db().previewMergeRebuild.findFirst({ where: { projectId: id } }),
        (row) => row?.failure != null,
      );

      expect(await builds(id)).toHaveLength(1);
      const page = await getPreview(id);
      expect(page.mergeRebuild).toMatchObject({ runId, status: 'failed' });
      expect(page.mergeRebuild.reason).toContain('The Compose file was refused');
      expect(await stateOf(id, runId, merged)).toBe('failed');
    });
  });

  describe('the migration', () => {
    it('lets only a build carry the Run that started it', async () => {
      const id = await createProject();
      const insert = (kind: string, runId: string | null) =>
        db().$executeRaw`
          INSERT INTO preview_operations (project_id, kind, status, started_by_run_id)
          VALUES (${id}::uuid, ${kind}, 'requested', ${runId}::uuid)`;

      await expect(insert('stop', randomUUID())).rejects.toThrow();
      await expect(insert('stop', null)).resolves.toBe(1);
    });

    it('stores at most one rebuild per Project, and the failure with its time or neither', async () => {
      const id = await createProject();
      const insert = (failure: string | null, failedAt: Date | null) =>
        db().$executeRaw`
          INSERT INTO preview_merge_rebuilds
            (project_id, run_id, merged_commit, merged_at, fetch_started_at, recorded_at, failure, failed_at)
          VALUES (${id}::uuid, ${randomUUID()}::uuid, ${'e'.repeat(40)}, now(), now(), now(),
                  ${failure}, ${failedAt}::timestamptz)`;

      await expect(insert('only the reason', null)).rejects.toThrow();
      await expect(insert(null, new Date())).rejects.toThrow();
      await expect(insert(null, null)).resolves.toBe(1);
      await expect(insert(null, null)).rejects.toThrow();
    });
  });
});
