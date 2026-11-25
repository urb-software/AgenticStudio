import { createHash, createSecretKey, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE_RULES } from '@agentic-studio/contracts';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import { createGitFixture, pushFiles } from './git-fixture.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// The agents list and detail over HTTP on the real app (PostgreSQL and Redis via Testcontainers).
// The cases that read a Clone need the real `git`, so they run on Linux only, against a local Git
// remote (a `file://` URL, accepted under a test-only setting).

// A throwaway worker token generated per run; no token is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const linux = process.platform === 'linux';
const SHA = /^[0-9a-f]{40}$/;

const agentFile = (name: string, extra = '', instructions = `Work as ${name}.\n`) =>
  `---\nname: ${name}\ndescription: Does the ${name} work\nprovider: codex\n${extra}---\n${instructions}`;

interface ListedAgent {
  name: string;
  description: string | null;
  provider: string | null;
  model: string | null;
  source: string;
  usable: boolean;
  problems: { code: string; path: string; key: string | null; message: string }[];
}

describe('agents API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let dataDir: string;
  let fixtureRoot: string;
  let app: INestApplication;
  let cookie: string;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const asOperator = (call: request.Test) => call.set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
  const listAgents = () => http().get('/api/agents').set('Cookie', cookie);
  const getAgent = (name: string) =>
    http()
      .get(`/api/agents/${encodeURIComponent(name)}`)
      .set('Cookie', cookie);
  const names = (body: { agents: ListedAgent[] }) => body.agents.map((agent) => agent.name);
  const definitionsOnly = (body: { agents: ListedAgent[] }) =>
    body.agents.filter((agent) => agent.source === 'definitions');

  async function createDefinitionsProject(): Promise<string> {
    const created = await asOperator(http().post('/api/projects')).send({
      name: 'Agent definitions',
      kind: 'definitions',
    });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  const connect = (projectId: string, url: string) =>
    asOperator(http().post(`/api/projects/${projectId}/repository`)).send({
      url,
      integrationBranch: 'dev',
    });

  /** Polls the Repository until it leaves `connecting` and `fetching`, as the web app does. */
  async function settled(projectId: string) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const response = await http()
        .get(`/api/projects/${projectId}/repository`)
        .set('Cookie', cookie);
      expect(response.status).toBe(200);
      if (!['connecting', 'fetching'].includes(response.body.state)) return response.body;
      if (Date.now() > deadline) throw new Error(`the repository stayed ${response.body.state}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** A definitions Project connected to a local remote holding `files` on `dev`, and its fixture. */
  async function connectedWith(name: string, files: Record<string, string | Buffer>) {
    const fixture = createGitFixture(fixtureRoot, name);
    const commit = pushFiles(fixture, 'dev', fixture.commits.dev!, files);
    const projectId = await createDefinitionsProject();
    expect((await connect(projectId, fixture.url)).status).toBe(201);
    expect((await settled(projectId)).state).toBe('ready');
    return { fixture, projectId, commit };
  }

  beforeAll(async () => {
    services = await startStudioServices();
    dataDir = await mkdtemp(join(tmpdir(), 'studio-agents-http-'));
    fixtureRoot = await mkdtemp(join(tmpdir(), 'studio-agents-fixtures-'));
    services.config = { ...services.config, dataDir, gitAllowFileRemotes: true };
    app = await startStudioApp({ ...services.config, workerToken: WORKER_TOKEN_DIGEST });
    cookie = await signIn(app);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Test isolation only; the Repository goes with its Project.
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
  });

  describe('without a definitions Repository', () => {
    it('lists the built-in Default agents and the base rules, with no commit', async () => {
      const response = await listAgents();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        commit: null,
        repository: null,
        truncated: false,
        baseRules: { version: BASE_RULES.version, text: BASE_RULES.text },
        agents: [
          {
            name: 'default-claude-code',
            description: expect.any(String),
            provider: 'claude_code',
            model: 'default',
            source: 'built_in',
            usable: true,
            problems: [],
          },
          {
            name: 'default-codex',
            description: expect.any(String),
            provider: 'codex',
            model: 'default',
            source: 'built_in',
            usable: true,
            problems: [],
          },
        ],
      });
    });

    it('answers the same while the definitions Project has no Repository yet', async () => {
      await createDefinitionsProject();

      const response = await listAgents();

      expect(response.body).toMatchObject({ commit: null, repository: null });
      expect(names(response.body)).toEqual(['default-claude-code', 'default-codex']);
    });

    it('shows a built-in agent in detail, with no instructions and no files', async () => {
      const response = await getAgent('default-codex');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        commit: null,
        repository: null,
        agent: expect.objectContaining({
          name: 'default-codex',
          source: 'built_in',
          instructions: '',
          files: [],
        }),
      });
    });

    it('answers 404 for an unknown agent', async () => {
      const response = await getAgent('nope');

      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
      expect(response.body.type).toBe('urn:agentic-studio:problem:agent-not-found');
    });
  });

  describe('a Repository that is not ready', () => {
    async function insertRepository(
      projectId: string,
      columns: { state: string; head?: string; failure?: boolean },
    ) {
      const url = 'https://git.example.test/acme/agents.git';
      await db().$executeRaw`
        INSERT INTO repositories
          (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at,
           failure_code, failure_detail)
        VALUES (${projectId}::uuid, ${url}, ${url.slice(8, -4)}, 'dev', ${columns.state},
                ${columns.head ?? null}, ${columns.head ? new Date() : null},
                ${columns.failure ? 'unknown' : null}, ${columns.failure ? 'It failed.' : null})`;
    }

    it('shows only the built-in agents and the reason while there is no Clone', async () => {
      const projectId = await createDefinitionsProject();
      await insertRepository(projectId, { state: 'failed', failure: true });

      const response = await listAgents();

      expect(response.status).toBe(200);
      expect(response.body.commit).toBeNull();
      expect(response.body.repository).toEqual({ state: 'failed', note: expect.any(String) });
      expect(names(response.body)).toEqual(['default-claude-code', 'default-codex']);
    });

    it('says why when the Clone is gone from disk', async () => {
      const projectId = await createDefinitionsProject();
      await insertRepository(projectId, { state: 'ready', head: 'a'.repeat(40) });

      const response = await listAgents();

      expect(response.status).toBe(200);
      expect(response.body.commit).toBeNull();
      expect(response.body.repository.state).toBe('ready');
      expect(response.body.repository.note).toEqual(expect.any(String));
      expect(names(response.body)).toEqual(['default-claude-code', 'default-codex']);
    });

    it.runIf(linux)('shows the last known list with a note while a fetch runs', async () => {
      const { projectId, commit } = await connectedWith('not-ready', {
        'agents/reviewer/AGENT.md': agentFile('reviewer'),
      });
      await db().$executeRaw`UPDATE repositories SET state = 'fetching'
        WHERE project_id = ${projectId}::uuid`;

      const response = await listAgents();

      expect(response.body.commit).toBe(commit);
      expect(response.body.repository).toEqual({ state: 'fetching', note: expect.any(String) });
      expect(names(response.body)).toEqual(['default-claude-code', 'default-codex', 'reviewer']);
    });
  });

  describe.runIf(linux)('with the real git (Linux)', () => {
    const BIG = Buffer.alloc(1024 * 1024 + 1, 0x61);
    // Not UTF-8 text, so the entry file is refused as unreadable.
    const NOT_TEXT = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x42]);

    it('lists a valid agent, an invalid one, one over the limits, a binary entry file and a reserved name', async () => {
      const { commit } = await connectedWith('mixed', {
        'agents/reviewer/AGENT.md': agentFile('reviewer', 'model: gpt-6.2-sol\n'),
        'agents/reviewer/notes/style.md': '# Style\n',
        'agents/broken/AGENT.md':
          '---\nname: broken\ndescription: Broken\nprovider: nope\n---\nx\n',
        'agents/heavy/AGENT.md': agentFile('heavy'),
        'agents/heavy/blob.bin': BIG,
        'agents/binary/AGENT.md': NOT_TEXT,
        'agents/default-codex/AGENT.md': agentFile('default-codex'),
        'skills/helper/SKILL.md': 'skills are ignored for now\n',
      });

      const response = await listAgents();

      expect(response.status).toBe(200);
      expect(response.body.commit).toBe(commit);
      expect(response.body.commit).toMatch(SHA);
      expect(response.body.repository).toEqual({ state: 'ready', note: null });
      expect(response.body.truncated).toBe(false);
      expect(names(response.body)).toEqual([
        'default-claude-code',
        'default-codex',
        'binary',
        'broken',
        'default-codex',
        'heavy',
        'reviewer',
      ]);
      const byName = (name: string) =>
        definitionsOnly(response.body).find((agent) => agent.name === name)!;
      expect(byName('reviewer')).toMatchObject({
        description: 'Does the reviewer work',
        provider: 'codex',
        model: 'gpt-6.2-sol',
        usable: true,
        problems: [],
      });
      expect(byName('broken')).toMatchObject({ usable: false, provider: null });
      expect(byName('broken').problems).toEqual([
        expect.objectContaining({ code: 'provider_unknown', path: 'AGENT.md', key: null }),
      ]);
      expect(byName('heavy').problems).toEqual([
        expect.objectContaining({ code: 'file_too_large', path: 'blob.bin' }),
      ]);
      expect(byName('binary').problems.map((problem) => problem.code)).toEqual([
        'entry_unreadable',
      ]);
      expect(
        definitionsOnly(response.body).filter((agent) => agent.name === 'default-codex'),
      ).toEqual([
        expect.objectContaining({
          source: 'definitions',
          usable: false,
          problems: [expect.objectContaining({ code: 'name_reserved' })],
        }),
      ]);
    });

    it('bounds the list at 200 agent folders and says so', async () => {
      const files: Record<string, string> = {};
      for (let index = 0; index < 201; index += 1) {
        const name = `agent-${String(index).padStart(3, '0')}`;
        files[`agents/${name}/AGENT.md`] = agentFile(name);
      }
      await connectedWith('hundreds', files);

      const response = await listAgents();

      expect(response.status).toBe(200);
      expect(response.body.truncated).toBe(true);
      expect(definitionsOnly(response.body)).toHaveLength(200);
      expect(definitionsOnly(response.body).every((agent) => agent.usable)).toBe(true);
    });

    it('reflects a fetch that brings new commits without another action', async () => {
      const { fixture, projectId, commit } = await connectedWith('fetching', {
        'agents/reviewer/AGENT.md': agentFile('reviewer'),
      });
      expect((await listAgents()).body.commit).toBe(commit);
      const next = pushFiles(fixture, 'dev', commit, {
        'agents/reviewer/AGENT.md': agentFile('reviewer'),
        'agents/planner/AGENT.md': agentFile('planner'),
      });

      const fetched = await asOperator(http().post(`/api/projects/${projectId}/repository/fetch`));
      expect(fetched.status).toBe(202);
      await settled(projectId);
      const response = await listAgents();

      expect(response.body.commit).toBe(next);
      expect(definitionsOnly(response.body).map((agent) => agent.name)).toEqual([
        'planner',
        'reviewer',
      ]);
    });

    it('shows an agent in detail with its instructions as written, and its files with sizes', async () => {
      const instructions = '# Heading\n\n<script>alert(1)</script> and [a link](https://x.test)\n';
      await connectedWith('detail', {
        'agents/reviewer/AGENT.md': agentFile('reviewer', '', instructions),
        'agents/reviewer/notes/style.md': '# Style\n',
        'agents/broken/AGENT.md': '---\nname: broken\n---\nx\n',
      });

      const response = await getAgent('reviewer');

      expect(response.status).toBe(200);
      expect(response.body.repository).toEqual({ state: 'ready', note: null });
      expect(response.body.agent).toMatchObject({
        name: 'reviewer',
        source: 'definitions',
        usable: true,
        instructions,
      });
      expect(response.body.agent.files).toEqual([
        { path: 'AGENT.md', size: Buffer.byteLength(agentFile('reviewer', '', instructions)) },
        { path: 'notes/style.md', size: 8 },
      ]);
      const broken = await getAgent('broken');
      expect(broken.body.agent).toMatchObject({ usable: false, instructions: '' });
      expect(broken.body.agent.problems.length).toBeGreaterThan(0);
      expect((await getAgent('missing')).status).toBe(404);
    });

    it('leaves no working tree behind in the Clone', async () => {
      await connectedWith('bare', { 'agents/reviewer/AGENT.md': agentFile('reviewer') });

      await listAgents();
      await getAgent('reviewer');

      // The reads go to Git's object store: nothing of the Repository is written into the data
      // directory outside the bare Clone.
      const entries = await readdir(dataDir, { recursive: true });
      expect(entries.filter((entry) => entry.endsWith('AGENT.md'))).toEqual([]);
    });
  });

  describe('access', () => {
    it.each(['/api/agents', '/api/agents/default-codex'])(
      'answers %s to the operator session only',
      async (path) => {
        expect((await http().get(path)).status).toBe(401);
        expect((await http().get(path).set('Authorization', `Bearer ${WORKER_TOKEN}`)).status).toBe(
          401,
        );
        expect((await http().get(path).set('Cookie', cookie)).status).toBe(200);
      },
    );
  });

  it('keeps the fixed definitions-repository route ahead of the agent name', async () => {
    const response = await http().get('/api/agents/definitions-repository').set('Cookie', cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ project: null });
  });

  it('does not accept a write', async () => {
    expect((await asOperator(http().put('/api/agents/default-codex')).send({})).status).toBe(404);
    expect((await asOperator(http().post('/api/agents')).send({})).status).toBe(404);
  });
});
