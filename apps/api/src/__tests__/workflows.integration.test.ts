import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// The Workflows list and detail over HTTP on the real app (PostgreSQL and Redis via Testcontainers).
// The cases that read a Clone need the real `git`, so they run on Linux only, against a local Git
// remote (a `file://` URL, accepted under a test-only setting).

// A throwaway worker token generated per run; no token is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const linux = process.platform === 'linux';
const NOT_FOUND = 'urn:agentic-studio:problem:workflow-not-found';
const WORKER_ID = randomUUID();

const agentFile = (name: string, provider: string, extra = '') =>
  `---\nname: ${name}\ndescription: Does the ${name} work\nprovider: ${provider}\n${extra}---\nWork.\n`;

const workflowFile = (name: string, items: string, extra = '') =>
  `---\nname: ${name}\ndescription: Does ${name}\n${extra}sequence:\n${items}\n---\nNotes.\n`;

const SHIP_ITEMS = [
  '  - id: build\n    kind: work\n    agent: builder',
  '  - id: ask\n    kind: checkpoint\n    text: Look before going on',
  '  - id: check\n    kind: review\n    agent: reviewer',
].join('\n');

interface Listed {
  name: string;
  description: string | null;
  valid: boolean;
  usable: boolean;
  notUsableReason: string | null;
  problems: { code: string; path: string; key: string | null; message: string }[];
}

describe('workflows API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let dataDir: string;
  let fixtureRoot: string;
  let app: INestApplication;
  let cookie: string;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const asOperator = (call: request.Test) => call.set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
  const listWorkflows = () => http().get('/api/workflows').set('Cookie', cookie);
  const getWorkflow = (encodedName: string) =>
    http().get(`/api/workflows/${encodedName}`).set('Cookie', cookie);
  const getAgent = (name: string) => http().get(`/api/agents/${name}`).set('Cookie', cookie);
  const names = (body: { workflows: Listed[] }) => body.workflows.map((workflow) => workflow.name);
  const workerStatus = (providers: object) =>
    http()
      .post('/api/worker/status')
      .set('Authorization', `Bearer ${WORKER_TOKEN}`)
      .send({ workerId: WORKER_ID, runner: 'cli', providers });

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

  const AGENTS = {
    'agents/builder/AGENT.md': agentFile('builder', 'claude_code'),
    'agents/reviewer/AGENT.md': agentFile('reviewer', 'codex'),
  };

  beforeAll(async () => {
    services = await startStudioServices();
    dataDir = await mkdtemp(join(tmpdir(), 'studio-workflows-http-'));
    fixtureRoot = await mkdtemp(join(tmpdir(), 'studio-workflows-fixtures-'));
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
    expect((await workerStatus({ claude_code: true, codex: true })).status).toBe(204);
  });

  describe('without a definitions Repository', () => {
    it('lists no Workflow and no commit, and the detail is a 404', async () => {
      const response = await listWorkflows();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        commit: null,
        repository: null,
        truncated: false,
        workflows: [],
      });
      expect((await getWorkflow('ship')).status).toBe(404);
    });
  });

  describe('access', () => {
    it.each(['/api/workflows', '/api/workflows/ship'])(
      'answers %s to the operator session only',
      async (path) => {
        expect((await http().get(path)).status).toBe(401);
        expect((await http().get(path).set('Authorization', `Bearer ${WORKER_TOKEN}`)).status).toBe(
          401,
        );
        expect([200, 404]).toContain((await http().get(path).set('Cookie', cookie)).status);
      },
    );
  });

  describe.runIf(linux)('with the real git (Linux)', () => {
    it('lists a valid Workflow, an invalid one per kind of reason, and one naming a missing agent', async () => {
      const { commit } = await connectedWith('mixed', {
        ...AGENTS,
        'workflows/ship/WORKFLOW.md': workflowFile('ship', SHIP_ITEMS),
        'workflows/first/WORKFLOW.md': workflowFile(
          'first',
          '  - id: ask\n    kind: checkpoint\n    text: Wait\n  - id: build\n    kind: work\n    agent: builder',
        ),
        'workflows/hooked/WORKFLOW.md': workflowFile('hooked', SHIP_ITEMS, 'hooks: x\n'),
        'workflows/extra/WORKFLOW.md': workflowFile('extra', SHIP_ITEMS),
        'workflows/extra/notes.txt': 'not allowed\n',
        'workflows/lost/WORKFLOW.md': workflowFile(
          'lost',
          '  - id: build\n    kind: work\n    agent: nobody',
        ),
        'workflows/empty/notes.txt': 'no entry file\n',
      });

      const response = await listWorkflows();

      expect(response.status).toBe(200);
      expect(response.body.commit).toBe(commit);
      expect(response.body.repository).toEqual({ state: 'ready', note: null });
      expect(response.body.truncated).toBe(false);
      expect(names(response.body)).toEqual(['empty', 'extra', 'first', 'hooked', 'lost', 'ship']);
      const by = new Map((response.body.workflows as Listed[]).map((w) => [w.name, w]));
      expect(by.get('ship')).toEqual({
        name: 'ship',
        description: 'Does ship',
        valid: true,
        usable: true,
        notUsableReason: null,
        problems: [],
      });
      const codes = (name: string) => by.get(name)?.problems.map((p) => p.code);
      expect(codes('empty')).toContain('entry_missing');
      expect(codes('extra')).toEqual(['workflow_extra_file']);
      expect(codes('first')).toEqual(['checkpoint_first']);
      expect(codes('hooked')).toEqual(['forbidden_key']);
      expect(by.get('hooked')).toMatchObject({ description: null, valid: false, usable: false });
      expect(by.get('lost')?.problems).toEqual([
        expect.objectContaining({ code: 'phase_agent_missing', key: 'nobody' }),
      ]);
    });

    it('lists a valid Workflow as not usable, naming the phase and the Provider, while one is off', async () => {
      await connectedWith('provider-off', {
        ...AGENTS,
        'workflows/ship/WORKFLOW.md': workflowFile('ship', SHIP_ITEMS),
      });
      expect((await workerStatus({ claude_code: true, codex: false })).status).toBe(204);

      const off = (await listWorkflows()).body.workflows[0] as Listed;

      expect(off).toMatchObject({ name: 'ship', valid: true, usable: false, problems: [] });
      expect(off.notUsableReason).toContain('The phase "check" uses Codex');
      expect(off.notUsableReason).toContain('not available');

      expect((await workerStatus({ claude_code: true, codex: true })).status).toBe(204);
      expect(((await listWorkflows()).body.workflows[0] as Listed).usable).toBe(true);
    });

    it('shows a Workflow in detail with its items in order and the send-back limit', async () => {
      const { commit } = await connectedWith('detail', {
        ...AGENTS,
        'workflows/ship/WORKFLOW.md': workflowFile('ship', SHIP_ITEMS, 'send-backs: 1\n'),
        'workflows/broken/WORKFLOW.md': '---\nname: broken\n---\nx\n',
      });

      const response = await getWorkflow('ship');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        commit,
        repository: { state: 'ready', note: null },
        name: 'ship',
        description: 'Does ship',
        valid: true,
        usable: true,
        notUsableReason: null,
        problems: [],
        sendBacks: 1,
        items: [
          {
            kind: 'work',
            id: 'build',
            agent: 'builder',
            agentState: 'valid',
            provider: 'claude_code',
            usable: true,
          },
          { kind: 'checkpoint', id: 'ask', text: 'Look before going on' },
          {
            kind: 'review',
            id: 'check',
            agent: 'reviewer',
            agentState: 'valid',
            provider: 'codex',
            usable: true,
          },
        ],
      });
      const broken = await getWorkflow('broken');
      expect(broken.body).toMatchObject({ valid: false, sendBacks: null, items: [] });
      expect(broken.body.problems.length).toBeGreaterThan(0);
    });

    it('reads a Workflow of the largest allowed number of items', async () => {
      const items = Array.from(
        { length: 12 },
        (_, index) => `  - id: p${index}\n    kind: work\n    agent: builder`,
      ).join('\n');
      await connectedWith('largest', {
        ...AGENTS,
        'workflows/big/WORKFLOW.md': workflowFile('big', items),
      });

      const response = await getWorkflow('big');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ valid: true, usable: true });
      expect(response.body.items).toHaveLength(12);
    });

    it('bounds the list at 200 Workflow folders and says so, and still shows one beyond them', async () => {
      const files: Record<string, string> = { ...AGENTS };
      for (let index = 0; index < 201; index += 1) {
        const name = `flow-${String(index).padStart(3, '0')}`;
        files[`workflows/${name}/WORKFLOW.md`] = workflowFile(
          name,
          '  - id: build\n    kind: work\n    agent: builder',
        );
      }
      await connectedWith('hundreds', files);

      const response = await listWorkflows();

      expect(response.status).toBe(200);
      expect(response.body.truncated).toBe(true);
      expect(response.body.workflows).toHaveLength(200);
      const beyond = await getWorkflow('flow-200');
      expect(beyond.status).toBe(200);
      expect(beyond.body.valid).toBe(true);
    });

    it('reflects a fetch that brings new commits without another action', async () => {
      const { fixture, projectId, commit } = await connectedWith('fetching', {
        ...AGENTS,
        'workflows/ship/WORKFLOW.md': workflowFile('ship', SHIP_ITEMS),
      });
      expect((await listWorkflows()).body.commit).toBe(commit);
      const next = pushFiles(fixture, 'dev', commit, {
        ...AGENTS,
        'workflows/ship/WORKFLOW.md': workflowFile('ship', SHIP_ITEMS),
        'workflows/planner/WORKFLOW.md': workflowFile(
          'planner',
          '  - id: build\n    kind: work\n    agent: builder',
        ),
      });

      const fetched = await asOperator(http().post(`/api/projects/${projectId}/repository/fetch`));
      expect(fetched.status).toBe(202);
      await settled(projectId);
      const response = await listWorkflows();

      expect(response.body.commit).toBe(next);
      expect(names(response.body)).toEqual(['planner', 'ship']);
    });

    it('names the Workflows on the agent they use, valid or not, sorted', async () => {
      await connectedWith('used-by', {
        ...AGENTS,
        'workflows/zed/WORKFLOW.md': workflowFile('zed', SHIP_ITEMS),
        'workflows/alpha/WORKFLOW.md': workflowFile('alpha', SHIP_ITEMS, 'colour: red\n'),
        'workflows/other/WORKFLOW.md': workflowFile(
          'other',
          '  - id: build\n    kind: work\n    agent: reviewer',
        ),
      });

      const builder = await getAgent('builder');
      expect(builder.status).toBe(200);
      expect(builder.body.usedByWorkflows).toEqual(['alpha', 'zed']);
      expect(builder.body.usedByWorkflowsTruncated).toBe(false);
      expect((await getAgent('reviewer')).body.usedByWorkflows).toEqual(['alpha', 'other', 'zed']);
      expect((await getAgent('default-codex')).body.usedByWorkflows).toEqual([]);
    });

    it('answers a 404 problem for an unknown name and for names that are not Workflow names', async () => {
      await connectedWith('names', {
        ...AGENTS,
        'workflows/ship/WORKFLOW.md': workflowFile('ship', SHIP_ITEMS),
      });

      const unknown = await getWorkflow('nope');
      expect(unknown.status).toBe(404);
      expect(unknown.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(problemDetailsSchema.safeParse(unknown.body).success).toBe(true);
      expect(unknown.body.type).toBe(NOT_FOUND);

      for (const encoded of ['a%20b', '%3Cscript%3E', 'A', '-a', 'a'.repeat(65)]) {
        const response = await getWorkflow(encoded);
        expect(response.status, encoded).toBe(404);
        expect(response.body.type, encoded).toBe(NOT_FOUND);
      }
      for (const encoded of ['%2e%2e', 'a%2Fb', '..%2F..%2Fetc%2Fpasswd']) {
        expect((await getWorkflow(encoded)).status, encoded).toBe(404);
      }
    });
  });
});
