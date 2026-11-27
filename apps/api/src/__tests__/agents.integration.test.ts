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
import { createGitFixture, type FixtureFile, pushFiles } from './git-fixture.js';
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
// Over 255 characters in all, made of segments Linux accepts.
const LONG_PATH = `docs/${'a'.repeat(100)}/${'b'.repeat(100)}/${'c'.repeat(100)}.md`;

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
  async function connectedWith(name: string, files: Record<string, FixtureFile>) {
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
    // The migration seeds the one Draft row: it goes back to its start.
    await db().$executeRaw`DELETE FROM agent_draft_files`;
    await db().$executeRaw`UPDATE agent_drafts SET base_commit = NULL, version = 0`;
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
            skills: [],
          },
          {
            name: 'default-codex',
            description: expect.any(String),
            provider: 'codex',
            model: 'default',
            source: 'built_in',
            usable: true,
            problems: [],
            skills: [],
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
        usedByWorkflows: [],
        usedByWorkflowsTruncated: false,
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

  describe('the files of the definitions Repository', () => {
    const files = () =>
      http().get('/api/agents/definitions-repository/files').set('Cookie', cookie);
    const content = (query: Record<string, string>) =>
      http()
        .get('/api/agents/definitions-repository/files/content')
        .query(query)
        .set('Cookie', cookie);

    it('answers an empty tree without a Repository, and 404 for any file', async () => {
      const tree = await files();

      expect(tree.status).toBe(200);
      expect(tree.body).toEqual({ commit: null, repository: null, truncated: false, entries: [] });
      const read = await content({ path: 'agents/a/AGENT.md' });
      expect(read.status).toBe(404);
      expect(read.body.type).toBe('urn:agentic-studio:problem:agent-file-not-found');
      expect(problemDetailsSchema.safeParse(read.body).success).toBe(true);
    });

    it.each([
      '../x',
      'agents/../../x',
      '/etc/passwd',
      'agents\\a\\AGENT.md',
      './a',
      'a//b',
      'a/',
      '.git/config',
    ])('refuses the path %j with 400', async (path) => {
      const response = await content({ path });

      expect(response.status).toBe(400);
      expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
    });

    it.each([{}, { path: '' }, { path: 'a', commit: 'HEAD' }, { path: 'a', commit: 'ABC' }])(
      'refuses the query %j with 400',
      async (query) => {
        expect((await content(query as Record<string, string>)).status).toBe(400);
      },
    );

    it('answers the operator session only', async () => {
      for (const path of [
        '/api/agents/definitions-repository/files',
        '/api/agents/definitions-repository/files/content?path=a',
      ]) {
        expect((await http().get(path)).status).toBe(401);
        expect((await http().get(path).set('Authorization', `Bearer ${WORKER_TOKEN}`)).status).toBe(
          401,
        );
      }
      expect((await files()).status).toBe(200);
    });

    describe.runIf(linux)('with the real git (Linux)', () => {
      const BIG = Buffer.alloc(1024 * 1024 + 1, 0x61);
      const BINARY = Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x04]);
      const NOT_UTF8 = Buffer.from([0x61, 0xff, 0xfe, 0x62]);

      it('lists the whole Repository with sizes and the agent of each entry', async () => {
        const { commit } = await connectedWith('tree', {
          'README.md': '# Agents\n',
          'agents/reviewer/AGENT.md': agentFile('reviewer'),
          'agents/reviewer/notes/style.md': '# Style\n',
          'agents/broken/AGENT.md': '---\nname: broken\n---\nx\n',
          'skills/helper/SKILL.md': 'skill\n',
          'docs/my notes "q" é.txt': 'abc',
        });

        const response = await files();

        expect(response.status).toBe(200);
        expect(response.body.commit).toBe(commit);
        expect(response.body.repository).toEqual({ state: 'ready', note: null });
        expect(response.body.truncated).toBe(false);
        const byPath = new Map(
          (
            response.body.entries as {
              path: string;
              kind: string;
              size: number;
              agent: string | null;
              skill: string | null;
            }[]
          ).map((entry) => [entry.path, entry]),
        );
        expect(byPath.get('README.md')).toEqual({
          path: 'README.md',
          kind: 'file',
          size: 9,
          agent: null,
          skill: null,
          openable: true,
        });
        expect(byPath.get('agents/reviewer/notes/style.md')).toEqual({
          path: 'agents/reviewer/notes/style.md',
          kind: 'file',
          size: 8,
          agent: 'reviewer',
          skill: null,
          openable: true,
        });
        expect(byPath.get('agents/broken/AGENT.md')?.agent).toBe('broken');
        expect(byPath.get('skills/helper/SKILL.md')?.agent).toBeNull();
        expect(byPath.get('skills/helper/SKILL.md')?.skill).toBe('helper');
        expect(byPath.get('docs/my notes "q" é.txt')?.size).toBe(3);
      });

      it('bounds the tree at 2,000 entries and says so', async () => {
        const many: Record<string, string> = {};
        for (let index = 0; index < 2005; index += 1)
          many[`f/${String(index).padStart(4, '0')}`] = 'x';
        await connectedWith('big-tree', many);

        const response = await files();

        expect(response.status).toBe(200);
        expect(response.body.entries).toHaveLength(2000);
        expect(response.body.truncated).toBe(true);
      });

      it('reads a text file, a binary one, and one over the limit', async () => {
        const { commit } = await connectedWith('contents', {
          'agents/reviewer/AGENT.md': agentFile('reviewer'),
          'run.sh': '#!/bin/sh\necho "<b>hi</b>"\n',
          'blob.zip': BINARY,
          'latin.txt': NOT_UTF8,
          'huge.txt': BIG,
          'empty.txt': '',
          'notes/my file "q" é.md': '# é\n',
        });

        const text = await content({ path: 'run.sh' });
        expect(text.status).toBe(200);
        expect(text.body).toEqual({
          commit,
          path: 'run.sh',
          kind: 'text',
          content: '#!/bin/sh\necho "<b>hi</b>"\n',
        });
        expect((await content({ path: 'empty.txt' })).body).toMatchObject({
          kind: 'text',
          content: '',
        });
        expect((await content({ path: 'notes/my file "q" é.md' })).body).toMatchObject({
          kind: 'text',
          content: '# é\n',
        });
        expect((await content({ path: 'blob.zip' })).body).toEqual({
          commit,
          path: 'blob.zip',
          kind: 'binary',
          size: BINARY.length,
        });
        expect((await content({ path: 'latin.txt' })).body).toMatchObject({
          kind: 'binary',
          size: NOT_UTF8.length,
        });
        expect((await content({ path: 'huge.txt' })).body).toEqual({
          commit,
          path: 'huge.txt',
          kind: 'too_large',
          size: BIG.length,
        });
      });

      it('answers a big non-UTF-8 file as binary with its real size, never as too large', async () => {
        const kib = 1024;
        const { commit } = await connectedWith('big-binary', {
          'ff-600k.bin': Buffer.alloc(600 * kib, 0xff),
          'ff-1000k.bin': Buffer.alloc(1000 * kib, 0xff),
          'log.txt': 'ok \uFFFD ok\n',
        });

        expect((await content({ path: 'ff-600k.bin' })).body).toEqual({
          commit,
          path: 'ff-600k.bin',
          kind: 'binary',
          size: 600 * kib,
        });
        expect((await content({ path: 'ff-1000k.bin' })).body).toMatchObject({
          kind: 'binary',
          size: 1000 * kib,
        });
        expect((await content({ path: 'log.txt' })).body).toMatchObject({
          kind: 'text',
          content: 'ok \uFFFD ok\n',
        });
      });

      it('lists a symbolic link and a submodule, marks them not openable, and never reads them', async () => {
        await connectedWith('links', {
          'real.txt': 'real\n',
          'link.txt': { symlink: 'real.txt' },
          'vendor/lib': { gitlink: 'c'.repeat(40) },
          [LONG_PATH]: 'long\n',
        });

        const tree = await files();
        const byPath = new Map(
          (tree.body.entries as { path: string; kind: string; openable: boolean }[]).map((item) => [
            item.path,
            item,
          ]),
        );
        expect(byPath.get('real.txt')).toMatchObject({ kind: 'file', openable: true });
        expect(byPath.get('link.txt')).toMatchObject({ kind: 'symlink', size: 0, openable: false });
        expect(byPath.get('vendor/lib')).toMatchObject({ kind: 'submodule', openable: false });
        expect(byPath.get(LONG_PATH)?.openable).toBe(false);
        for (const path of ['link.txt', 'vendor/lib', 'vendor']) {
          const response = await content({ path });
          expect(response.status).toBe(404);
          expect(response.body.type).toBe('urn:agentic-studio:problem:agent-file-not-found');
        }
      });

      it('answers 404 for a missing file or a folder, and reads the commit asked for', async () => {
        const { fixture, projectId, commit } = await connectedWith('commits', {
          'a.txt': 'one\n',
        });
        const next = pushFiles(fixture, 'dev', commit, { 'a.txt': 'two\n' });
        expect(
          (await asOperator(http().post(`/api/projects/${projectId}/repository/fetch`))).status,
        ).toBe(202);
        await settled(projectId);

        expect((await content({ path: 'a.txt' })).body).toMatchObject({
          commit: next,
          content: 'two\n',
        });
        expect((await content({ path: 'a.txt', commit })).body).toMatchObject({
          commit,
          content: 'one\n',
        });
        expect((await content({ path: 'nope.txt' })).status).toBe(404);
        expect((await content({ path: 'agents' })).status).toBe(404);
        const unknown = await content({ path: 'a.txt', commit: 'f'.repeat(40) });
        expect(unknown.status).toBe(404);
        expect(unknown.body.type).toBe('urn:agentic-studio:problem:agent-commit-not-found');
      });

      it('leaves no working tree behind in the Clone', async () => {
        await connectedWith('files-bare', { 'docs/readme.md': '# hi\n' });

        await files();
        await content({ path: 'docs/readme.md' });

        const entries = await readdir(dataDir, { recursive: true });
        expect(entries.filter((entry) => entry.endsWith('readme.md'))).toEqual([]);
      });
    });
  });

  describe('the Draft', () => {
    const BASE = '/api/agents/definitions-repository/draft';
    const getDraft = () => http().get(BASE).set('Cookie', cookie);
    const put = (body: Record<string, unknown>) =>
      asOperator(http().put(`${BASE}/files`)).send(body);
    const move = (from: string, to: string) =>
      asOperator(http().post(`${BASE}/files/move`)).send({ from, to });
    const revert = (path: string) => asOperator(http().post(`${BASE}/files/revert`)).send({ path });
    const remove = (path: string) => asOperator(http().delete(`${BASE}/files`).query({ path }));
    const discard = () => asOperator(http().delete(BASE));
    const draftContent = (path: string) =>
      http().get(`${BASE}/files/content`).query({ path }).set('Cookie', cookie);
    const draftFiles = (body: { files: { path: string; change: string }[] }) =>
      body.files.map((file) => [file.path, file.change]);

    describe('without a definitions Repository', () => {
      it('is empty, and a write is refused for lack of a commit to base it on', async () => {
        const empty = await getDraft();

        expect(empty.status).toBe(200);
        expect(empty.body).toEqual({
          baseCommit: null,
          currentCommit: null,
          version: 0,
          files: [],
          problems: [],
          skillProblems: [],
          judged: true,
          notJudgedReason: null,
          movedUpstream: [],
        });
        const refused = await put({ path: 'agents/a/AGENT.md', text: 'x' });
        expect(refused.status).toBe(409);
        expect(refused.body.type).toBe('urn:agentic-studio:problem:agent-draft-no-base');
        expect(problemDetailsSchema.safeParse(refused.body).success).toBe(true);
        expect((await draftContent('agents/a/AGENT.md')).status).toBe(404);
      });

      it('discards an empty Draft and raises its version', async () => {
        const first = await discard();
        const second = await discard();

        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ version: 1, files: [], baseCommit: null });
        expect(second.body.version).toBe(2);
        expect((await getDraft()).body.version).toBe(2);
      });

      it('answers the operator session only, and writes need the Studio origin', async () => {
        for (const path of [BASE, `${BASE}/files/content?path=a`]) {
          expect((await http().get(path)).status).toBe(401);
          expect(
            (await http().get(path).set('Authorization', `Bearer ${WORKER_TOKEN}`)).status,
          ).toBe(401);
        }
        const body = { path: 'a.md', text: 'x' };
        expect((await http().put(`${BASE}/files`).set('Cookie', cookie).send(body)).status).toBe(
          403,
        );
        expect(
          (await http().post(`${BASE}/files/move`).set('Cookie', cookie).send({})).status,
        ).toBe(403);
        expect((await http().delete(BASE).set('Cookie', cookie)).status).toBe(403);
        expect((await http().delete(`${BASE}/files?path=a`).set('Cookie', cookie)).status).toBe(
          403,
        );
        expect(
          (await http().put(`${BASE}/files`).set({ Origin: STUDIO_ORIGIN }).send(body)).status,
        ).toBe(401);
      });

      it.each([
        [{ path: '../x', text: 'x' }],
        [{ path: '.git/config', text: 'x' }],
        [{ path: 'a\\b', text: 'x' }],
        [{ path: 'a.md' }],
        [{ path: 'a.md', text: 'x', contentBase64: 'eA==' }],
        [{ path: 'a.md', contentBase64: 'not base64!' }],
        [{ path: 'a.md', text: 'x', extra: true }],
      ])('refuses the body %j with 400', async (body) => {
        const response = await put(body);

        expect(response.status).toBe(400);
        expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
      });

      it('refuses a bad path of a move, a delete and a content read with 400', async () => {
        expect((await move('a.md', '../x')).status).toBe(400);
        expect((await move('/a.md', 'b.md')).status).toBe(400);
        expect((await remove('../x')).status).toBe(400);
        expect((await draftContent('../x')).status).toBe(400);
        expect((await asOperator(http().delete(`${BASE}/files`))).status).toBe(400);
      });

      it('accepts a body of up to two file limits and refuses a larger one with 413', async () => {
        const large = await put({ path: 'a.md', text: 'a'.repeat(1_500_000) });
        expect(large.status).toBe(409);

        const huge = await put({ path: 'a.md', text: 'a'.repeat(2 * 1024 * 1024 + 1024) });
        expect(huge.status).toBe(413);
        expect(problemDetailsSchema.safeParse(huge.body).success).toBe(true);
      });

      it('gives the large body limit only to a request with the Studio origin and a session cookie', async () => {
        const body = { path: 'a.md', text: 'a'.repeat(150_000) };

        const noCookie = await http()
          .put(`${BASE}/files`)
          .set({ Origin: STUDIO_ORIGIN })
          .send(body);
        const noOrigin = await http().put(`${BASE}/files`).set('Cookie', cookie).send(body);
        const signedIn = await put(body);

        expect(noCookie.status).toBe(413);
        expect(noOrigin.status).toBe(413);
        expect(signedIn.status).toBe(409);
      });

      it('answers a revert like the other writes', async () => {
        expect((await revert('a.md')).status).toBe(404);
        expect((await revert('../x')).status).toBe(400);
        expect((await asOperator(http().post(`${BASE}/files/revert`)).send({})).status).toBe(400);
        expect((await http().post(`${BASE}/files/revert`).send({ path: 'a.md' })).status).toBe(403);
      });
    });

    describe.runIf(linux)('with the real git (Linux)', () => {
      const DRAFT_FILES = {
        'README.md': '# Agents\n',
        'agents/reviewer/AGENT.md': agentFile('reviewer'),
        'agents/reviewer/notes.txt': 'notes\n',
        'docs/guide.md': 'guide\n',
        'link.md': { symlink: 'README.md' },
      };

      it('stores a modified and an added file against the current commit and shows them', async () => {
        const { commit } = await connectedWith('draft-write', DRAFT_FILES);

        const first = await put({ path: 'README.md', text: '# Edited\n' });
        const second = await put({ path: 'docs/new.md', text: 'new\n' });

        expect(first.status).toBe(200);
        expect(first.body).toEqual({
          baseCommit: commit,
          currentCommit: commit,
          version: 1,
          files: [{ path: 'README.md', change: 'modified', size: 9, movedFrom: null, skill: null }],
          problems: [],
          skillProblems: [],
          judged: true,
          notJudgedReason: null,
          movedUpstream: [],
        });
        expect(second.body.version).toBe(2);
        expect(draftFiles(second.body)).toEqual([
          ['README.md', 'modified'],
          ['docs/new.md', 'added'],
        ]);
        expect((await getDraft()).body).toEqual(second.body);
        const written = await draftContent('README.md');
        expect(written.body).toEqual({
          commit,
          path: 'README.md',
          kind: 'text',
          content: '# Edited\n',
        });
        const untouched = await draftContent('docs/guide.md');
        expect(untouched.body).toMatchObject({ kind: 'text', content: 'guide\n' });
        expect((await draftContent('nothing.md')).status).toBe(404);
      });

      it('keeps the last write of a path', async () => {
        await connectedWith('draft-last', DRAFT_FILES);
        await put({ path: 'docs/new.md', text: 'first' });

        const second = await put({ path: 'docs/new.md', text: 'second, longer' });

        expect(second.body.files).toEqual([
          { path: 'docs/new.md', change: 'added', size: 14, movedFrom: null, skill: null },
        ]);
        expect((await draftContent('docs/new.md')).body.content).toBe('second, longer');
      });

      it('reaches no agent: the agents, one agent in detail and the tree stay as they were', async () => {
        await connectedWith('draft-no-agent', DRAFT_FILES);
        const before = {
          list: (await listAgents()).body,
          reviewer: (await getAgent('reviewer')).body,
          tree: (await http().get('/api/agents/definitions-repository/files').set('Cookie', cookie))
            .body,
        };

        await put({
          path: 'agents/reviewer/AGENT.md',
          text: agentFile('reviewer', '', 'Rewritten in the Draft.\n'),
        });
        await put({ path: 'agents/drafted/AGENT.md', text: agentFile('drafted') });
        await remove('agents/reviewer/notes.txt');

        expect((await listAgents()).body).toEqual(before.list);
        expect((await getAgent('reviewer')).body).toEqual(before.reviewer);
        expect((await getAgent('drafted')).status).toBe(404);
        expect(
          (await http().get('/api/agents/definitions-repository/files').set('Cookie', cookie)).body,
        ).toEqual(before.tree);
        expect((await getDraft()).body.files).toHaveLength(3);
      });

      it('saves a file with a forbidden key and flags it in the problems', async () => {
        await connectedWith('draft-problems', DRAFT_FILES);

        const saved = await put({
          path: 'agents/drafted/AGENT.md',
          text: agentFile('drafted', 'tools: Bash\n'),
        });

        expect(saved.status).toBe(200);
        expect(saved.body.problems).toEqual([
          {
            agent: 'drafted',
            code: 'forbidden_key',
            path: 'agents/drafted/AGENT.md',
            key: 'tools',
            message: expect.any(String),
          },
        ]);
        const fixed = await put({
          path: 'agents/drafted/AGENT.md',
          text: agentFile('drafted'),
        });
        expect(fixed.body.problems).toEqual([]);
        const broken = await remove('agents/reviewer/AGENT.md');
        expect(broken.body.problems.map((p: { code: string }) => p.code)).toEqual([
          'entry_missing',
        ]);
      });

      it('moves, deletes and discards, and an emptied Draft has no base', async () => {
        const { commit } = await connectedWith('draft-flow', DRAFT_FILES);

        const moved = await move('docs/guide.md', 'docs/handbook.md');
        expect(moved.status).toBe(200);
        expect(moved.body.baseCommit).toBe(commit);
        expect(moved.body.files).toEqual([
          { path: 'docs/guide.md', change: 'deleted', size: 0, movedFrom: null, skill: null },
          {
            path: 'docs/handbook.md',
            change: 'added',
            size: 6,
            movedFrom: 'docs/guide.md',
            skill: null,
          },
        ]);
        expect((await draftContent('docs/handbook.md')).body.content).toBe('guide\n');
        expect((await draftContent('docs/guide.md')).status).toBe(404);

        // Reverting the new path of a moved file removes it and restores the original.
        const restored = await revert('docs/handbook.md');
        expect(restored.status).toBe(200);
        expect(restored.body).toMatchObject({ files: [], baseCommit: null });

        await remove('README.md');
        const discarded = await discard();
        expect(discarded.body).toMatchObject({ files: [], baseCommit: null });
        expect(discarded.body.version).toBeGreaterThan(restored.body.version);
      });

      it('deletes in one call and reverts a change, each answering the new Draft', async () => {
        await connectedWith('draft-delete-revert', DRAFT_FILES);
        await put({ path: 'README.md', text: 'edited' });
        await put({ path: 'docs/new.md', text: 'new' });

        const deleted = await remove('README.md');
        expect(draftFiles(deleted.body)).toEqual([
          ['README.md', 'deleted'],
          ['docs/new.md', 'added'],
        ]);
        expect((await draftContent('README.md')).status).toBe(404);
        const gone = await remove('docs/new.md');
        expect(draftFiles(gone.body)).toEqual([['README.md', 'deleted']]);
        expect((await remove('README.md')).status).toBe(404);

        const back = await revert('README.md');
        expect(back.body).toMatchObject({ files: [], baseCommit: null });
        expect((await draftContent('README.md')).body).toMatchObject({ content: '# Agents\n' });
        expect(back.body.version).toBe(5);
      });

      it('keeps both files when two writes to different paths race, and the version rises by two', async () => {
        await connectedWith('draft-race', DRAFT_FILES);
        const before = (await put({ path: 'docs/start.md', text: 'start' })).body.version;

        const [first, second] = await Promise.all([
          put({ path: 'docs/one.md', text: 'one' }),
          put({ path: 'docs/two.md', text: 'two' }),
        ]);

        expect([first.status, second.status]).toEqual([200, 200]);
        expect(first.body.version).not.toBe(second.body.version);
        const view = await getDraft();
        expect(draftFiles(view.body)).toEqual([
          ['docs/one.md', 'added'],
          ['docs/start.md', 'added'],
          ['docs/two.md', 'added'],
        ]);
        expect(view.body.version).toBe(before + 2);
        expect((await draftContent('docs/one.md')).body.content).toBe('one');
        expect((await draftContent('docs/two.md')).body.content).toBe('two');
      });

      it('says so when the commit the Draft began from is gone', async () => {
        await connectedWith('draft-base-gone', DRAFT_FILES);
        await put({ path: 'docs/new.md', text: 'new' });
        await db().$executeRaw`UPDATE agent_drafts SET base_commit = ${'f'.repeat(40)}`;

        const refused = await put({ path: 'docs/other.md', text: 'x' });

        expect(refused.status).toBe(409);
        expect(refused.body.type).toBe('urn:agentic-studio:problem:agent-draft-base-missing');
        expect(problemDetailsSchema.safeParse(refused.body).success).toBe(true);
        expect((await getDraft()).status).toBe(200);
        const discarded = await discard();
        expect(discarded.body).toMatchObject({ files: [], baseCommit: null });
      });

      it('discards the Draft when the definitions Repository is disconnected', async () => {
        const { projectId } = await connectedWith('draft-disconnect', DRAFT_FILES);
        await put({ path: 'docs/new.md', text: 'new' });

        const disconnected = await asOperator(
          http().delete(`/api/projects/${projectId}/repository`),
        );

        expect(disconnected.status).toBeLessThan(300);
        const view = await getDraft();
        expect(view.body).toMatchObject({ files: [], baseCommit: null });
        expect(view.body.version).toBeGreaterThan(1);
      });

      it('refuses what the rules forbid, each with its own problem', async () => {
        await connectedWith('draft-rules', DRAFT_FILES);

        const large = await put({
          path: 'big.bin',
          contentBase64: Buffer.alloc(1024 * 1024 + 1, 1).toString('base64'),
        });
        expect(large.status).toBe(422);
        expect(large.body.type).toBe('urn:agentic-studio:problem:agent-draft-file-too-large');
        expect(large.body).toMatchObject({ size: 1024 * 1024 + 1, limit: 1024 * 1024 });
        expect(problemDetailsSchema.safeParse(large.body).success).toBe(true);

        const link = await put({ path: 'link.md', text: 'x' });
        expect(link.status).toBe(422);
        expect(link.body.type).toBe('urn:agentic-studio:problem:agent-draft-path-not-writable');
        expect((await remove('link.md')).status).toBe(422);

        const taken = await move('README.md', 'docs/guide.md');
        expect(taken.status).toBe(422);
        expect(taken.body.type).toBe('urn:agentic-studio:problem:agent-draft-path-taken');

        const conflict = await put({ path: 'agents/reviewer', text: 'x' });
        expect(conflict.status).toBe(422);
        expect(conflict.body.type).toBe('urn:agentic-studio:problem:agent-draft-path-conflict');

        const missing = await remove('nothing.md');
        expect(missing.status).toBe(404);
        expect((await move('nothing.md', 'x.md')).status).toBe(404);
        // Nothing was stored by any refusal.
        expect((await getDraft()).body).toMatchObject({ files: [], version: 0 });
      });

      it('moves onto a path the Draft deleted', async () => {
        await connectedWith('draft-replace', DRAFT_FILES);
        await remove('docs/guide.md');

        const replaced = await move('README.md', 'docs/guide.md');

        expect(replaced.status).toBe(200);
        expect(draftFiles(replaced.body)).toEqual([
          ['README.md', 'deleted'],
          ['docs/guide.md', 'modified'],
        ]);
      });

      it('carries a binary upload within the limit, and a binary base file when it moves', async () => {
        await connectedWith('draft-binary', {
          ...DRAFT_FILES,
          'blob.bin': Buffer.from([0x50, 0x00, 0x03]),
        });
        const bytes = Buffer.from([0x00, 0xff, 0x10, 0x20]);

        const uploaded = await put({
          path: 'assets/icon.bin',
          contentBase64: bytes.toString('base64'),
        });

        expect(uploaded.status).toBe(200);
        expect(uploaded.body.files).toEqual([
          { path: 'assets/icon.bin', change: 'added', size: 4, movedFrom: null, skill: null },
        ]);
        const read = await draftContent('assets/icon.bin');
        expect(read.body).toMatchObject({ kind: 'binary', size: 4 });
        const moved = await move('blob.bin', 'assets/blob.bin');
        expect(moved.status).toBe(200);
        expect(moved.body.files).toContainEqual({
          path: 'assets/blob.bin',
          change: 'added',
          size: 3,
          movedFrom: 'blob.bin',
          skill: null,
        });
        expect((await draftContent('assets/blob.bin')).body).toMatchObject({
          kind: 'binary',
          size: 3,
        });
      });

      it('keeps its base when the Repository moves on, and lists what moved upstream', async () => {
        const { fixture, projectId, commit } = await connectedWith('draft-upstream', DRAFT_FILES);
        await put({ path: 'README.md', text: '# Mine\n' });
        await put({ path: 'docs/guide.md', text: 'my guide\n' });
        await put({ path: 'docs/new.md', text: 'new\n' });
        const next = pushFiles(fixture, 'dev', commit, {
          ...Object.fromEntries(Object.entries(DRAFT_FILES).filter(([path]) => path !== 'link.md')),
          'README.md': '# Changed upstream\n',
          'agents/planner/AGENT.md': agentFile('planner'),
        });
        const fetched = await asOperator(
          http().post(`/api/projects/${projectId}/repository/fetch`),
        );
        expect(fetched.status).toBe(202);
        await settled(projectId);

        const view = await getDraft();

        expect(view.body.baseCommit).toBe(commit);
        expect(view.body.currentCommit).toBe(next);
        expect(view.body.movedUpstream).toEqual(['README.md']);
        // A new write keeps the first base, and the Draft content is still the operator's.
        const written = await put({ path: 'docs/another.md', text: 'x' });
        expect(written.body.baseCommit).toBe(commit);
        expect((await draftContent('README.md')).body).toMatchObject({
          commit,
          content: '# Mine\n',
        });
      });
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
