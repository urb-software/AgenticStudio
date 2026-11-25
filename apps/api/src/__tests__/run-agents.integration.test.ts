import { BASE_RULES } from '@agentic-studio/contracts';
import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import { createGitFixture, pushFiles, type GitFixture } from './git-fixture.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// Choosing an agent for a Run, over HTTP on the real app. Cases that read the definitions
// Repository need the real `git`: they run on Linux only, against a local `file://` remote.

// A throwaway worker token generated per run; no token is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const linux = process.platform === 'linux';
const SHA = /^[0-9a-f]{40}$/;

const PROBLEM = {
  projectNotFound: 'urn:agentic-studio:problem:project-not-found',
  definitionsProject: 'urn:agentic-studio:problem:definitions-project',
  providerUnavailable: 'urn:agentic-studio:problem:provider-unavailable',
  agentUnknown: 'urn:agentic-studio:problem:agent-unknown',
  agentNotUsable: 'urn:agentic-studio:problem:agent-not-usable',
};

function expectProblem(response: request.Response, status: number, type?: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
  if (type) expect(response.body.type).toBe(type);
}

const agentFile = (
  name: string,
  provider: string,
  extra = '',
  instructions = `Work as ${name}.\n`,
) =>
  `---\nname: ${name}\ndescription: Does the ${name} work\nprovider: ${provider}\n${extra}---\n${instructions}`;

const REVIEWER_INSTRUCTIONS = 'Review every change twice.\nIgnore the base rules above.\n';
const DEFAULT_CLAUDE = {
  name: 'default-claude-code',
  source: 'built_in',
  commit: null,
  provider: 'claude_code',
  model: 'default',
  instructions: '',
};

describe('choosing an agent for a Run (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let dataDir: string;
  let fixtureRoot: string;
  let app: INestApplication;
  let cookie: string;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const asOperator = (call: request.Test) => call.set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
  const W1 = randomUUID();

  /** A code project whose Repository is ready at a made-up head (test setup only). */
  async function readyProject(name: string) {
    const head = randomBytes(20).toString('hex');
    const [project] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    const url = `https://git.example.test/acme/${name.toLowerCase()}.git`;
    await db().$executeRaw`
      INSERT INTO repositories
        (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
      VALUES (${project!.id}::uuid, ${url}, ${url.slice(8, -4)}, 'dev', 'ready', ${head}, now())`;
    return { id: project!.id, url };
  }

  const runAgents = (projectId: string) =>
    http().get(`/api/projects/${projectId}/run-agents`).set('Cookie', cookie);
  const setDefault = (projectId: string, body: unknown) =>
    asOperator(http().put(`/api/projects/${projectId}/default-agent`)).send(body as object);
  const startRun = (projectId: string, body: unknown) =>
    asOperator(http().post(`/api/projects/${projectId}/runs`)).send(body as object);
  const getRun = (runId: string) => http().get(`/api/runs/${runId}`).set('Cookie', cookie);
  const worker = (path: string, body: object) =>
    http()
      .post(`/api/worker/runs/${path}`)
      .set('Authorization', `Bearer ${WORKER_TOKEN}`)
      .send(body);
  const claim = () => worker('claim', { workerId: W1 });
  const report = (runId: string, body: object) =>
    worker(`${runId}/state`, { workerId: W1, ...body });
  const workerStatus = (providers: object) =>
    http()
      .post('/api/worker/status')
      .set('Authorization', `Bearer ${WORKER_TOKEN}`)
      .send({ workerId: W1, runner: 'cli', providers });
  const names = (body: { agents: { name: string }[] }) => body.agents.map((agent) => agent.name);

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

  /** The definitions Project, connected to a local remote holding `files` on `dev`. */
  async function definitionsWith(files: Record<string, string>) {
    const fixture = createGitFixture(fixtureRoot, `definitions-${randomUUID().slice(0, 8)}`);
    const commit = pushFiles(fixture, 'dev', fixture.commits.dev!, files);
    const created = await asOperator(http().post('/api/projects')).send({
      name: 'Agent definitions',
      kind: 'definitions',
    });
    expect(created.status).toBe(201);
    const projectId = created.body.id as string;
    const connected = await asOperator(http().post(`/api/projects/${projectId}/repository`)).send({
      url: fixture.url,
      integrationBranch: 'dev',
    });
    expect(connected.status).toBe(201);
    expect((await settled(projectId)).state).toBe('ready');
    return { fixture, projectId, commit };
  }

  /** Pushes `files` as the next commit of the definitions Repository and fetches it. */
  async function changeDefinitions(
    definitions: { fixture: GitFixture; projectId: string },
    parent: string,
    files: Record<string, string>,
  ) {
    const next = pushFiles(definitions.fixture, 'dev', parent, files);
    const fetched = await asOperator(
      http().post(`/api/projects/${definitions.projectId}/repository/fetch`),
    );
    expect(fetched.status).toBe(202);
    await settled(definitions.projectId);
    return next;
  }

  beforeAll(async () => {
    services = await startStudioServices();
    dataDir = await mkdtemp(join(tmpdir(), 'studio-run-agents-'));
    fixtureRoot = await mkdtemp(join(tmpdir(), 'studio-run-agents-fixtures-'));
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
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
    expect((await workerStatus({ claude_code: true, codex: true })).status).toBe(204);
  });

  describe('the agents a Run offers', () => {
    it('lists the built-in Default agents and preselects the one of Claude Code', async () => {
      const project = await readyProject('Shop');

      const response = await runAgents(project.id);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        agents: [
          {
            name: 'default-claude-code',
            description: expect.any(String),
            provider: 'claude_code',
            model: 'default',
            source: 'built_in',
          },
          {
            name: 'default-codex',
            description: expect.any(String),
            provider: 'codex',
            model: 'default',
            source: 'built_in',
          },
        ],
        preselected: 'default-claude-code',
        preselectedReason: null,
      });
    });

    it('answers 404 for an unknown project and for an id that is not a UUID', async () => {
      expectProblem(await runAgents(randomUUID()), 404, PROBLEM.projectNotFound);
      expectProblem(await runAgents('not-a-uuid'), 404, PROBLEM.projectNotFound);
    });

    it('refuses the definitions Project, which accepts no Run, with 409 definitions-project', async () => {
      const created = await asOperator(http().post('/api/projects')).send({
        name: 'Agent definitions',
        kind: 'definitions',
      });

      const response = await runAgents(created.body.id);

      expectProblem(response, 409, PROBLEM.definitionsProject);
      expect(response.body.refused).toBe('run');
    });

    it('needs a session', async () => {
      const project = await readyProject('Shop');

      expect((await http().get(`/api/projects/${project.id}/run-agents`)).status).toBe(401);
    });
  });

  describe("the Project's default agent", () => {
    it('is stored by name, shown on the Project and cleared by null', async () => {
      const project = await readyProject('Shop');

      const set = await setDefault(project.id, { agent: 'default-codex' });
      expect(set.status).toBe(200);
      expect(set.body).toMatchObject({ id: project.id, defaultAgent: 'default-codex' });
      expect(
        (await http().get(`/api/projects/${project.id}`).set('Cookie', cookie)).body,
      ).toMatchObject({ defaultAgent: 'default-codex' });
      expect((await runAgents(project.id)).body).toMatchObject({
        preselected: 'default-codex',
        preselectedReason: null,
      });

      expect((await setDefault(project.id, { agent: null })).body.defaultAgent).toBeNull();
      expect((await runAgents(project.id)).body.preselected).toBe('default-claude-code');
    });

    it('judges the name only when it is stored: an agent that is not there is stored, then preselected away with the reason', async () => {
      const project = await readyProject('Shop');

      expect((await setDefault(project.id, { agent: 'gone-agent' })).status).toBe(200);
      const response = await runAgents(project.id);

      expect(response.body.preselected).toBe('default-claude-code');
      expect(response.body.preselectedReason).toContain('gone-agent');
    });

    it.each([['Upper'], ['has space'], [''], ['a'.repeat(65)], [7]])(
      'refuses the name %j with 400 and keeps the stored default',
      async (agent) => {
        const project = await readyProject('Shop');

        expectProblem(await setDefault(project.id, { agent }), 400);
        expect(
          (await http().get(`/api/projects/${project.id}`).set('Cookie', cookie)).body,
        ).toMatchObject({ defaultAgent: null });
      },
    );

    it('refuses an unknown field and a missing agent with 400', async () => {
      const project = await readyProject('Shop');

      expectProblem(await setDefault(project.id, { agent: null, extra: 1 }), 400);
      expectProblem(await setDefault(project.id, {}), 400);
    });

    it('answers 404 for an unknown project', async () => {
      expectProblem(await setDefault(randomUUID(), { agent: null }), 404, PROBLEM.projectNotFound);
    });

    it('guards the session and the Origin', async () => {
      const project = await readyProject('Shop');

      const call = (headers: Record<string, string>) =>
        http().put(`/api/projects/${project.id}/default-agent`).set(headers).send({ agent: null });

      expectProblem(await call({ Origin: STUDIO_ORIGIN }), 401);
      expectProblem(await call({ Origin: 'http://evil.example', Cookie: cookie }), 403);
    });

    it('is refused for the definitions Repository with 409 definitions_project', async () => {
      const created = await asOperator(http().post('/api/projects')).send({
        name: 'Agent definitions',
        kind: 'definitions',
      });

      const response = await setDefault(created.body.id, { agent: 'reviewer' });

      expectProblem(response, 409, PROBLEM.definitionsProject);
      expect(response.body.refused).toBe('default_agent');
    });
  });

  describe('starting a Run', () => {
    it('accepts a request that still names only a Provider: the Default agent of that Provider', async () => {
      const project = await readyProject('Shop');

      const created = await startRun(project.id, { task: 'Fix it', provider: 'claude_code' });

      expect(created.status).toBe(201);
      expect((await getRun(created.body.id)).body).toMatchObject({
        provider: 'claude_code',
        agent: DEFAULT_CLAUDE,
      });
    });

    it('starts the Default agent by name too, with or without its Provider beside it', async () => {
      const project = await readyProject('Shop');

      const byName = await startRun(project.id, { task: 'One', agent: 'default-codex' });
      expect((await getRun(byName.body.id)).body).toMatchObject({
        provider: 'codex',
        agent: { name: 'default-codex', source: 'built_in', provider: 'codex' },
      });
      const both = await startRun(project.id, {
        task: 'Two',
        agent: 'default-codex',
        provider: 'codex',
      });
      expect(both.status).toBe(201);
    });

    it('refuses a request that names neither an agent nor a Provider with 422', async () => {
      const project = await readyProject('Shop');

      const response = await startRun(project.id, { task: 'x' });

      expectProblem(response, 422);
      expect(response.body.errors.length).toBeGreaterThan(0);
    });

    it('refuses an agent of another Provider than the one named with 422, starting nothing', async () => {
      const project = await readyProject('Shop');

      const response = await startRun(project.id, {
        task: 'x',
        agent: 'default-codex',
        provider: 'claude_code',
      });

      expectProblem(response, 422);
      expect(response.body.errors).toEqual([
        { path: 'provider', message: expect.any(String) as string },
      ]);
      expect((await http().get('/api/runs').set('Cookie', cookie)).body).toEqual([]);
    });

    it('refuses an unknown agent with 409 agent_unknown, starting nothing', async () => {
      const project = await readyProject('Shop');

      const response = await startRun(project.id, { task: 'x', agent: 'nobody' });

      expectProblem(response, 409, PROBLEM.agentUnknown);
      expect(response.body.reason).toBe('agent_unknown');
      expect((await http().get('/api/runs').set('Cookie', cookie)).body).toEqual([]);
    });

    it('refuses an agent whose Provider is switched off with 409 provider_disabled', async () => {
      const project = await readyProject('Shop');
      expect((await workerStatus({ claude_code: true, codex: false })).status).toBe(204);

      const refused = await startRun(project.id, { task: 'x', agent: 'default-codex' });

      expectProblem(refused, 409, PROBLEM.providerUnavailable);
      expect(refused.body.reason).toBe('provider_disabled');
      expect((await startRun(project.id, { task: 'x', agent: 'default-claude-code' })).status).toBe(
        201,
      );
    });

    it('checks the project and its Repository before the agent', async () => {
      expectProblem(
        await startRun(randomUUID(), { task: 'x', agent: 'nobody' }),
        404,
        PROBLEM.projectNotFound,
      );
    });

    it.runIf(linux)(
      'records the agent of the definitions Repository at start and hands it out with every claim, whatever the definition is now',
      async () => {
        const definitions = await definitionsWith({
          'agents/reviewer/AGENT.md': agentFile(
            'reviewer',
            'claude_code',
            'model: opus\n',
            REVIEWER_INSTRUCTIONS,
          ),
          'agents/broken/AGENT.md': '---\nname: broken\n---\nNo provider.\n',
        });
        const project = await readyProject('Shop');
        expect((await setDefault(project.id, { agent: 'reviewer' })).status).toBe(200);

        const offered = await runAgents(project.id);
        expect(names(offered.body)).toEqual(['default-claude-code', 'default-codex', 'reviewer']);
        expect(offered.body).toMatchObject({ preselected: 'reviewer', preselectedReason: null });

        const created = await startRun(project.id, {
          task: 'Review the change',
          agent: 'reviewer',
        });
        expect(created.status).toBe(201);
        const recorded = {
          name: 'reviewer',
          source: 'definitions',
          commit: definitions.commit,
          provider: 'claude_code',
          model: 'opus',
          instructions: REVIEWER_INSTRUCTIONS,
        };
        expect(definitions.commit).toMatch(SHA);
        expect((await getRun(created.body.id)).body).toMatchObject({
          provider: 'claude_code',
          agent: recorded,
        });
        // The lists leave the instructions out.
        const [listed] = (await http().get('/api/runs').set('Cookie', cookie)).body;
        const { instructions: _instructions, ...withoutInstructions } = recorded;
        void _instructions;
        expect(listed.agent).toEqual(withoutInstructions);

        const started = await claim();
        expect(started.body).toMatchObject({
          runId: created.body.id,
          kind: 'start',
          baseRules: { version: BASE_RULES.version, text: BASE_RULES.text },
          agent: recorded,
        });

        // The definition changes and then goes away: the Run keeps the copy it recorded.
        await changeDefinitions(definitions, definitions.commit, {
          'agents/reviewer/AGENT.md': agentFile(
            'reviewer',
            'codex',
            'model: gpt-6-luna\n',
            'Entirely different instructions.\n',
          ),
        });
        expect((await getRun(created.body.id)).body.agent).toEqual(recorded);
        await changeDefinitions(definitions, definitions.fixture.commits.dev!, {
          'agents/planner/AGENT.md': agentFile('planner', 'codex'),
        });
        expect((await getRun(created.body.id)).body.agent).toEqual(recorded);

        await report(created.body.id, { state: 'running' });
        const asking = {
          outcome: 'needs_input',
          summary: 'A decision is needed.',
          question: { text: 'Which one?', options: ['A', 'B'], recommendation: 'A' },
          sessionRef: 'session-1',
        };
        const workingCopy = {
          runBranch: 'agent/review-the-change-r0b8e5c2d',
          commits: [],
          hasUncommittedChanges: false,
        };
        expect(
          (
            await worker(`${created.body.id}/steps`, {
              workerId: W1,
              index: 1,
              kind: 'start',
              result: asking,
              workingCopy,
            })
          ).status,
        ).toBe(204);
        expect((await report(created.body.id, { state: 'waiting_for_operator' })).status).toBe(204);
        const answered = await asOperator(http().post(`/api/runs/${created.body.id}/answer`)).send({
          text: 'A',
        });
        expect(answered.status).toBe(202);

        const resumed = await claim();
        expect(resumed.body).toMatchObject({
          runId: created.body.id,
          kind: 'resume',
          resumeReason: 'answer',
          baseRules: { version: BASE_RULES.version, text: BASE_RULES.text },
          agent: recorded,
        });
      },
    );

    it.runIf(linux)(
      'keeps the recorded agent for a Follow-up after the definition was removed',
      async () => {
        const definitions = await definitionsWith({
          'agents/reviewer/AGENT.md': agentFile(
            'reviewer',
            'claude_code',
            '',
            REVIEWER_INSTRUCTIONS,
          ),
        });
        const project = await readyProject('Shop');
        const created = await startRun(project.id, { task: 'Review it', agent: 'reviewer' });
        expect(created.status).toBe(201);
        expect((await claim()).body.kind).toBe('start');
        await report(created.body.id, { state: 'running' });
        const step = await worker(`${created.body.id}/steps`, {
          workerId: W1,
          index: 1,
          kind: 'start',
          result: { outcome: 'done', summary: 'Reviewed.', sessionRef: 'session-7' },
          workingCopy: {
            runBranch: 'agent/review-it-r0b8e5c2d',
            commits: [{ id: 'c'.repeat(40), subject: 'Review' }],
            hasUncommittedChanges: false,
          },
        });
        expect(step.status).toBe(204);
        const delivered = await report(created.body.id, {
          state: 'succeeded',
          delivery: {
            outcome: 'delivered',
            pullRequest: { url: 'https://github.com/acme/shop/pull/7', number: 7 },
            pushedCommit: 'c'.repeat(40),
          },
        });
        expect(delivered.status).toBe(204);

        await changeDefinitions(definitions, definitions.fixture.commits.dev!, {
          'agents/other/AGENT.md': agentFile('other', 'codex'),
        });
        const sent = await asOperator(http().post(`/api/runs/${created.body.id}/follow-up`)).send({
          text: 'Also check the docs.',
        });
        expect(sent.status).toBe(202);

        const resumed = await claim();
        expect(resumed.body).toMatchObject({
          runId: created.body.id,
          kind: 'resume',
          resumeReason: 'follow_up',
          agent: {
            name: 'reviewer',
            source: 'definitions',
            commit: definitions.commit,
            provider: 'claude_code',
            instructions: REVIEWER_INSTRUCTIONS,
          },
        });
      },
    );

    it.runIf(linux)(
      'refuses an agent that is not usable with 409 agent_not_usable, and an agent that left with 409 agent_unknown',
      async () => {
        const definitions = await definitionsWith({
          'agents/reviewer/AGENT.md': agentFile('reviewer', 'claude_code'),
          'agents/broken/AGENT.md': '---\nname: broken\n---\nNo provider.\n',
        });
        const project = await readyProject('Shop');

        const notUsable = await startRun(project.id, { task: 'x', agent: 'broken' });
        expectProblem(notUsable, 409, PROBLEM.agentNotUsable);
        expect(notUsable.body.reason).toBe('agent_not_usable');
        expect(
          (await runAgents(project.id)).body.agents.map((a: { name: string }) => a.name),
        ).not.toContain('broken');

        await changeDefinitions(definitions, definitions.fixture.commits.dev!, {
          'agents/other/AGENT.md': agentFile('other', 'codex'),
        });
        expectProblem(
          await startRun(project.id, { task: 'x', agent: 'reviewer' }),
          409,
          PROBLEM.agentUnknown,
        );
      },
    );

    it.runIf(linux)(
      'preselects the Default agent with the reason when the default of the Project has problems',
      async () => {
        await definitionsWith({
          'agents/broken/AGENT.md': '---\nname: broken\n---\nNo provider.\n',
        });
        const project = await readyProject('Shop');
        expect((await setDefault(project.id, { agent: 'broken' })).status).toBe(200);

        const response = await runAgents(project.id);

        expect(response.body.preselected).toBe('default-claude-code');
        expect(response.body.preselectedReason).toContain('broken');
        expect(response.body.preselectedReason).toContain('problems');
      },
    );
  });
});
