import { spawnSync } from 'node:child_process';
import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import { createGitFixture, type FixtureFile, pushCommit, pushFiles } from './git-fixture.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';
import { createTestDataDir } from './test-config.js';

// Publishing a Draft over HTTP on the real app (PostgreSQL and Redis via Testcontainers), against a
// local Git remote (a `file://` URL, accepted under a test-only setting). The real `git` is needed
// to read and write the Clone, so this runs on Linux only.

const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const IDENTITY = { name: 'Studio Publisher', email: 'studio@example.test' };
const SHA = /^[0-9a-f]{40}$/;
const BASE = '/api/agents/definitions-repository/draft';
const linux = process.platform === 'linux';

const agentFile = (name: string, instructions = `Work as ${name}.\n`) =>
  `---\nname: ${name}\ndescription: Does the ${name} work\nprovider: codex\n---\n${instructions}`;

const FILES: Record<string, FixtureFile> = {
  'README.md': '# Agents\n',
  'agents/reviewer/AGENT.md': agentFile('reviewer', 'Review the change.\n'),
  'agents/reviewer/notes.txt': 'notes\n',
  'agents/reviewer/run.sh': { executable: '#!/bin/sh\necho one\n' },
  'docs/guide.md': 'guide\n',
};

function gitIn(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: cwd,
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

describe.runIf(linux)('publishing the Draft (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let dataDir: string;
  let fixtureRoot: string;
  let app: INestApplication;
  let cookie: string;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const asOperator = (call: request.Test) => call.set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
  const getDraft = () => http().get(BASE).set('Cookie', cookie);
  const put = (path: string, text: string) =>
    asOperator(http().put(`${BASE}/files`)).send({ path, text });
  const remove = (path: string) => asOperator(http().delete(`${BASE}/files`).query({ path }));
  const publish = (body: Record<string, unknown>) =>
    asOperator(http().post(`${BASE}/publish`)).send(body);
  const listAgents = () => http().get('/api/agents').set('Cookie', cookie);
  const repositoryOf = (projectId: string) =>
    http().get(`/api/projects/${projectId}/repository`).set('Cookie', cookie);

  async function settled(projectId: string) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const response = await repositoryOf(projectId);
      expect(response.status).toBe(200);
      if (!['connecting', 'fetching'].includes(response.body.state)) return response.body;
      if (Date.now() > deadline) throw new Error(`the repository stayed ${response.body.state}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** A definitions Project connected to a local remote holding `FILES` on `dev`. */
  async function connected(name: string) {
    const fixture = createGitFixture(fixtureRoot, name);
    const commit = pushFiles(fixture, 'dev', fixture.commits.dev!, FILES);
    const created = await asOperator(http().post('/api/projects')).send({
      name: 'Agent definitions',
      kind: 'definitions',
    });
    expect(created.status).toBe(201);
    const projectId = created.body.id as string;
    const connect = await asOperator(http().post(`/api/projects/${projectId}/repository`)).send({
      url: fixture.url,
      integrationBranch: 'dev',
    });
    expect(connect.status).toBe(201);
    expect((await settled(projectId)).state).toBe('ready');
    return { fixture, projectId, commit };
  }

  /** The Draft of a realistic change: a new agent, a changed instruction, a deleted file. */
  async function draftOfChanges() {
    expect((await put('agents/helper/AGENT.md', agentFile('helper'))).status).toBe(200);
    expect(
      (await put('agents/reviewer/AGENT.md', agentFile('reviewer', 'Review it twice.\n'))).status,
    ).toBe(200);
    expect((await put('agents/reviewer/run.sh', '#!/bin/sh\necho two\n')).status).toBe(200);
    expect((await remove('agents/reviewer/notes.txt')).status).toBe(200);
    return (await getDraft()).body as { baseCommit: string; version: number };
  }

  const body = (draft: { baseCommit: string; version: number }, message = 'Publish agents') => ({
    message,
    baseCommit: draft.baseCommit,
    version: draft.version,
  });

  beforeAll(async () => {
    services = await startStudioServices();
    dataDir = await mkdtemp(join(tmpdir(), 'studio-publish-http-'));
    fixtureRoot = await mkdtemp(join(tmpdir(), 'studio-publish-fixtures-'));
    services.config = { ...services.config, dataDir, gitAllowFileRemotes: true };
    app = await startStudioApp({
      ...services.config,
      workerToken: WORKER_TOKEN_DIGEST,
      definitionsCommitIdentity: IDENTITY,
    });
    cookie = await signIn(app);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    await db().$executeRaw`DELETE FROM agent_draft_files`;
    await db().$executeRaw`UPDATE agent_drafts SET base_commit = NULL, version = 0`;
  });

  it('commits the Draft on the Integration branch, discards it, and the agents list reads the new commit', async () => {
    const { fixture, projectId, commit } = await connected('publish-ok');
    const draft = await draftOfChanges();
    expect((await listAgents()).body.commit).toBe(commit);

    const published = await publish(body(draft, 'Add helper\n\nAnd review twice.'));

    expect(published.status).toBe(200);
    expect(published.body).toEqual({ commit: expect.stringMatching(SHA) });
    const next = published.body.commit as string;
    // The remote's branch is the new commit, one commit above the base, authored by the settings.
    expect(gitIn(fixture.bare, ['rev-parse', 'refs/heads/dev'])).toBe(next);
    expect(gitIn(fixture.bare, ['rev-parse', `${next}^`])).toBe(commit);
    expect(gitIn(fixture.bare, ['log', '-1', '--format=%an|%ae|%cn|%ce', next])).toBe(
      'Studio Publisher|studio@example.test|Studio Publisher|studio@example.test',
    );
    expect(gitIn(fixture.bare, ['log', '-1', '--format=%B', next])).toBe(
      'Add helper\n\nAnd review twice.',
    );
    expect(gitIn(fixture.bare, ['show', `${next}:agents/helper/AGENT.md`])).toBe(
      agentFile('helper').trimEnd(),
    );
    expect(gitIn(fixture.bare, ['ls-tree', next, 'agents/reviewer/run.sh'])).toMatch(/^100755 /);
    expect(gitIn(fixture.bare, ['ls-tree', '-r', '--name-only', next])).not.toContain(
      'agents/reviewer/notes.txt',
    );
    // The Draft is empty again, with a raised version.
    const after = await getDraft();
    expect(after.body).toMatchObject({ baseCommit: null, files: [], currentCommit: next });
    expect(after.body.version).toBeGreaterThan(draft.version);
    // The Clone follows the remote, and the agents list reads the new commit's agents.
    expect((await repositoryOf(projectId)).body).toMatchObject({ state: 'ready', headSha: next });
    const agents = await listAgents();
    expect(agents.body.commit).toBe(next);
    expect(
      agents.body.agents
        .filter((agent: { source: string }) => agent.source === 'definitions')
        .map((agent: { name: string }) => agent.name),
    ).toEqual(['helper', 'reviewer']);
  });

  it('answers 409 repository-moved when the remote moved past the Clone, and keeps the Clone and the Draft', async () => {
    const { fixture, projectId, commit } = await connected('publish-remote-moved');
    const draft = await draftOfChanges();
    const moved = pushCommit(fixture, 'dev');

    const refused = await publish(body(draft));

    expect(refused.status).toBe(409);
    expect(refused.body.type).toBe('urn:agentic-studio:problem:repository-moved');
    expect(problemDetailsSchema.safeParse(refused.body).success).toBe(true);
    expect(gitIn(fixture.bare, ['rev-parse', 'refs/heads/dev'])).toBe(moved);
    expect((await repositoryOf(projectId)).body).toMatchObject({ state: 'ready', headSha: commit });
    expect((await getDraft()).body).toMatchObject({
      baseCommit: commit,
      version: draft.version,
      files: expect.arrayContaining([expect.objectContaining({ path: 'agents/helper/AGENT.md' })]),
    });
  });

  it('answers 409 repository-moved when the Repository was fetched past the Draft base', async () => {
    const { fixture, projectId } = await connected('publish-fetched-past');
    const draft = await draftOfChanges();
    const moved = pushCommit(fixture, 'dev');
    expect(
      (await asOperator(http().post(`/api/projects/${projectId}/repository/fetch`))).status,
    ).toBe(202);
    expect((await settled(projectId)).headSha).toBe(moved);

    const refused = await publish(body(draft));

    expect(refused.status).toBe(409);
    expect(refused.body.type).toBe('urn:agentic-studio:problem:repository-moved');
    expect(gitIn(fixture.bare, ['rev-parse', 'refs/heads/dev'])).toBe(moved);
    expect((await getDraft()).body.version).toBe(draft.version);
  });

  it('answers 409 write-refused for a host that refuses the write, naming what to change, and keeps everything', async () => {
    const { fixture, projectId, commit } = await connected('publish-refused');
    const draft = await draftOfChanges();
    // The same refusal a read-only Deploy key gets, without a Git host: the remote declines the ref.
    gitIn(fixture.bare, ['config', 'receive.hideRefs', 'refs/heads/dev']);

    const refused = await publish(body(draft));

    expect(refused.status).toBe(409);
    expect(refused.body.type).toBe('urn:agentic-studio:problem:write-refused');
    expect(refused.body.detail).toMatch(/Deploy key/);
    expect(refused.body.detail).toMatch(/write access/i);
    // No text of the remote is in the answer.
    expect(JSON.stringify(refused.body)).not.toMatch(/hidden|remote rejected|fatal|\/tmp/i);
    expect(gitIn(fixture.bare, ['rev-parse', 'refs/heads/dev'])).toBe(commit);
    expect((await repositoryOf(projectId)).body).toMatchObject({ state: 'ready', headSha: commit });
    expect(
      gitIn(join(dataDir, 'clones', `${projectId}.git`), ['rev-parse', 'refs/heads/dev']),
    ).toBe(commit);
    const after = await getDraft();
    expect(after.body).toMatchObject({ baseCommit: commit, version: draft.version });
    expect(after.body.files).toHaveLength(4);
    // The bytes are kept too: the file reads as the Draft has it.
    const kept = await http()
      .get(`${BASE}/files/content`)
      .query({ path: 'agents/helper/AGENT.md' })
      .set('Cookie', cookie);
    expect(kept.body.content).toBe(agentFile('helper'));
  });

  it('refuses while the Draft has a problem, listing it, and publishes nothing', async () => {
    const { fixture, commit } = await connected('publish-problems');
    expect((await put('agents/broken/AGENT.md', 'no front matter\n')).status).toBe(200);
    const draft = (await getDraft()).body;

    const refused = await publish(body(draft));

    expect(refused.status).toBe(422);
    expect(refused.body.type).toBe('urn:agentic-studio:problem:publish-problems');
    expect(refused.body.problems).toEqual([
      expect.objectContaining({ agent: 'broken', path: expect.stringContaining('agents/broken') }),
    ]);
    expect(gitIn(fixture.bare, ['rev-parse', 'refs/heads/dev'])).toBe(commit);
  });

  it('refuses a Draft that changes a path outside agents/, listing it, and publishes nothing', async () => {
    const { fixture, commit } = await connected('publish-outside');
    expect((await put('agents/helper/AGENT.md', agentFile('helper'))).status).toBe(200);
    expect((await put('.github/workflows/ci.yml', 'name: ci')).status).toBe(200);
    const draft = (await getDraft()).body;

    const refused = await publish(body(draft));

    expect(refused.status).toBe(422);
    expect(refused.body.type).toBe('urn:agentic-studio:problem:publish-path-outside-agents');
    expect(refused.body.paths).toEqual(['.github/workflows/ci.yml']);
    expect(gitIn(fixture.bare, ['rev-parse', 'refs/heads/dev'])).toBe(commit);
  });

  it('answers 409 agent-draft-conflict when the Draft changed since the page read it', async () => {
    await connected('publish-stale');
    const draft = await draftOfChanges();
    expect((await put('docs/other.md', 'other\n')).status).toBe(200);

    const refused = await publish(body(draft));

    expect(refused.status).toBe(409);
    expect(refused.body.type).toBe('urn:agentic-studio:problem:agent-draft-conflict');
  });

  it('answers 409 nothing-to-publish for an empty Draft', async () => {
    await connected('publish-empty');
    const draft = (await getDraft()).body;

    const refused = await publish({
      message: 'Nothing',
      baseCommit: draft.currentCommit,
      version: draft.version,
    });

    expect(refused.status).toBe(409);
    expect(refused.body.type).toBe('urn:agentic-studio:problem:nothing-to-publish');
  });

  it('answers 400 for a message that is no message, and 400 for a body that names an identity', async () => {
    await connected('publish-bad-body');
    const draft = await draftOfChanges();

    expect((await publish({ ...body(draft), message: '' })).status).toBe(400);
    expect((await publish({ ...body(draft), message: '\n\nbody only' })).status).toBe(400);
    expect((await publish({ ...body(draft), message: 'x'.repeat(2001) })).status).toBe(400);
    expect((await publish({ ...body(draft), message: 'a\u0000b' })).status).toBe(400);
    expect(
      (await publish({ ...body(draft), identity: { name: 'Mallory', email: 'm@example.test' } }))
        .status,
    ).toBe(400);
    expect((await publish({ ...body(draft), author: 'Mallory' })).status).toBe(400);
    expect((await publish({ message: 'x' })).status).toBe(400);
  });

  it('lets one of two publishes at once make the commit and refuses the other', async () => {
    const { fixture, commit } = await connected('publish-two');
    const draft = await draftOfChanges();

    const [first, second] = await Promise.all([publish(body(draft)), publish(body(draft))]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const refused = first.status === 409 ? first : second;
    expect([
      'urn:agentic-studio:problem:publish-running',
      'urn:agentic-studio:problem:agent-draft-conflict',
    ]).toContain(refused.body.type);
    expect(gitIn(fixture.bare, ['rev-list', '--count', `${commit}..refs/heads/dev`])).toBe('1');
  });

  it('answers 503 publish-not-configured while the commit identity is not set', async () => {
    const unconfigured = await startStudioApp({
      ...services.config,
      dataDir: createTestDataDir(),
      workerToken: WORKER_TOKEN_DIGEST,
      definitionsCommitIdentity: null,
    });
    try {
      const signedIn = await signIn(unconfigured);

      const response = await request(unconfigured.getHttpServer())
        .post(`${BASE}/publish`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: signedIn })
        .send({ message: 'x', baseCommit: 'a'.repeat(40), version: 0 });

      expect(response.status).toBe(503);
      expect(response.body.type).toBe('urn:agentic-studio:problem:publish-not-configured');
    } finally {
      await unconfigured.close();
    }
  });

  it('answers the operator session with the Studio origin only: no worker token, no bare session', async () => {
    const payload = { message: 'x', baseCommit: 'a'.repeat(40), version: 0 };

    expect((await http().post(`${BASE}/publish`).send(payload)).status).toBe(403);
    expect(
      (
        await http()
          .post(`${BASE}/publish`)
          .set({ Origin: STUDIO_ORIGIN, Authorization: `Bearer ${WORKER_TOKEN}` })
          .send(payload)
      ).status,
    ).toBe(401);
    expect((await http().post(`${BASE}/publish`).set('Cookie', cookie).send(payload)).status).toBe(
      403,
    );
    expect(
      (await http().post(`${BASE}/publish`).set({ Origin: STUDIO_ORIGIN }).send(payload)).status,
    ).toBe(401);
  });

  describe('a Run that started before the publish', () => {
    const W1 = randomUUID();
    const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };
    const WORKING_COPY = {
      runBranch: 'agent/review-r0b8e5c2d',
      commits: [{ id: 'c'.repeat(40), subject: 'Review it' }],
      hasUncommittedChanges: false,
    };
    const worker = (path: string, payload: object) =>
      http()
        .post(`/api/worker/runs/${path}`)
        .set('Authorization', `Bearer ${WORKER_TOKEN}`)
        .send(payload);

    /** A project whose Repository is ready at a fake head: test setup only, no Git clone. */
    async function codeProject() {
      const [project] = await db().$queryRaw<{ id: string }[]>`
        INSERT INTO projects (name, name_normalized) VALUES ('Shop', 'shop') RETURNING id`;
      await db().$executeRaw`
        INSERT INTO repositories
          (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
        VALUES (${project!.id}::uuid, 'https://git.example.test/acme/shop.git',
                'git.example.test/acme/shop', 'dev', 'ready', ${randomBytes(20).toString('hex')},
                now())`;
      return project!.id;
    }

    const startRun = (projectId: string, agent: string) =>
      asOperator(http().post(`/api/projects/${projectId}/runs`)).send({ task: 'Review', agent });
    const getRun = (runId: string) => http().get(`/api/runs/${runId}`).set('Cookie', cookie);

    it('keeps the commit and instructions it recorded, also through a Follow-up, while a new Run reads the new commit', async () => {
      const { commit } = await connected('publish-runs');
      const projectId = await codeProject();
      expect(
        (
          await http()
            .post('/api/worker/status')
            .set('Authorization', `Bearer ${WORKER_TOKEN}`)
            .send({ workerId: W1, runner: 'cli', providers: { claude_code: true, codex: true } })
        ).status,
      ).toBe(204);
      const started = await startRun(projectId, 'reviewer');
      expect(started.status).toBe(201);
      const runId = started.body.id as string;
      const before = (await getRun(runId)).body.agent;
      expect(before).toMatchObject({
        name: 'reviewer',
        source: 'definitions',
        commit,
        instructions: 'Review the change.\n',
      });
      // The worker carries the Run to a delivered pull request.
      expect((await worker('claim', { workerId: W1 })).status).toBe(200);
      await worker(`${runId}/state`, { workerId: W1, state: 'running' });
      const done = { outcome: 'done', summary: 'Reviewed.', sessionRef: 'session-7' };
      expect(
        (
          await worker(`${runId}/steps`, {
            workerId: W1,
            index: 1,
            kind: 'start',
            result: done,
            workingCopy: WORKING_COPY,
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await worker(`${runId}/state`, {
            workerId: W1,
            state: 'succeeded',
            delivery: {
              outcome: 'delivered',
              pullRequest: PULL_REQUEST,
              pushedCommit: 'c'.repeat(40),
            },
          })
        ).status,
      ).toBe(204);

      // The publish changes the reviewer's instructions and moves the Repository on.
      const draft = await draftOfChanges();
      const published = await publish(body(draft));
      expect(published.status).toBe(200);
      const next = published.body.commit as string;

      // The Run keeps its commit; its Follow-up resumes with the agent it started with.
      expect((await getRun(runId)).body.agent).toEqual(before);
      const sent = await asOperator(http().post(`/api/runs/${runId}/follow-up`)).send({
        text: 'Also check the notes.',
      });
      expect(sent.status).toBe(202);
      const resumed = await worker('claim', { workerId: W1 });
      expect(resumed.status).toBe(200);
      expect(resumed.body).toMatchObject({
        runId,
        kind: 'resume',
        agent: { name: 'reviewer', commit, instructions: 'Review the change.\n' },
      });
      expect((await getRun(runId)).body.agent).toEqual(before);
      // A Run started now reads the new commit.
      const second = await startRun(projectId, 'reviewer');
      expect(second.status).toBe(201);
      expect((await getRun(second.body.id as string)).body.agent).toMatchObject({
        commit: next,
        instructions: 'Review it twice.\n',
      });
    });
  });
});
