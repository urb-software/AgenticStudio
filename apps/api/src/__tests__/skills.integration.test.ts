import { createHash, createSecretKey, randomBytes } from 'node:crypto';
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

// The skills list and detail over HTTP on the real app (PostgreSQL and Redis via Testcontainers).
// The cases that read a Clone need the real `git`, so they run on Linux only, against a local Git
// remote (a `file://` URL, accepted under a test-only setting).

// A throwaway worker token generated per run; no token is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
const linux = process.platform === 'linux';
const NOT_FOUND = 'urn:agentic-studio:problem:skill-not-found';

const skillFile = (name: string, extra = '', instructions = `Do the ${name} work.\n`) =>
  `---\nname: ${name}\ndescription: Does the ${name} work\n${extra}---\n${instructions}`;

interface ListedSkill {
  name: string;
  description: string | null;
  valid: boolean;
  problems: { code: string; path: string; key: string | null; message: string }[];
}

describe('skills API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let dataDir: string;
  let fixtureRoot: string;
  let app: INestApplication;
  let cookie: string;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const asOperator = (call: request.Test) => call.set({ Origin: STUDIO_ORIGIN, Cookie: cookie });
  const listSkills = () => http().get('/api/skills').set('Cookie', cookie);
  const getSkill = (encodedName: string) =>
    http().get(`/api/skills/${encodedName}`).set('Cookie', cookie);
  const names = (body: { skills: ListedSkill[] }) => body.skills.map((skill) => skill.name);

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
    dataDir = await mkdtemp(join(tmpdir(), 'studio-skills-http-'));
    fixtureRoot = await mkdtemp(join(tmpdir(), 'studio-skills-fixtures-'));
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
    it('lists no skill and no commit, and the detail is a 404', async () => {
      const response = await listSkills();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        commit: null,
        repository: null,
        truncated: false,
        skills: [],
      });
      expect((await getSkill('review')).status).toBe(404);
    });

    it('answers the same while the definitions Project has no Repository yet', async () => {
      await createDefinitionsProject();

      const response = await listSkills();

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ commit: null, repository: null, skills: [] });
    });
  });

  describe('access', () => {
    it.each(['/api/skills', '/api/skills/review'])(
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
    it('lists a valid skill, an invalid one per kind of reason, and a skill without an entry file', async () => {
      const { commit } = await connectedWith('mixed', {
        'skills/review/SKILL.md': skillFile('review'),
        'skills/review/references/guide.md': '# Guide\n',
        'skills/hooked/SKILL.md': skillFile('hooked', 'hooks: x\n'),
        'skills/shelled/SKILL.md': skillFile('shelled'),
        'skills/shelled/references/x.md': 'run !`ls` now\n',
        'skills/empty/notes.txt': 'no entry file\n',
        'agents/reviewer/AGENT.md':
          '---\nname: reviewer\ndescription: d\nprovider: codex\n---\nx\n',
      });

      const response = await listSkills();

      expect(response.status).toBe(200);
      expect(response.body.commit).toBe(commit);
      expect(response.body.repository).toEqual({ state: 'ready', note: null });
      expect(response.body.truncated).toBe(false);
      expect(names(response.body)).toEqual(['empty', 'hooked', 'review', 'shelled']);
      const bySkill = new Map((response.body.skills as ListedSkill[]).map((s) => [s.name, s]));
      expect(bySkill.get('review')).toEqual({
        name: 'review',
        description: 'Does the review work',
        valid: true,
        problems: [],
      });
      expect(bySkill.get('empty')?.problems.map((p) => p.code)).toEqual(['entry_missing']);
      expect(bySkill.get('hooked')).toMatchObject({ description: null, valid: false });
      expect(bySkill.get('hooked')?.problems).toEqual([
        expect.objectContaining({ code: 'forbidden_key', path: 'SKILL.md', key: 'hooks' }),
      ]);
      expect(bySkill.get('shelled')?.problems).toEqual([
        expect.objectContaining({ code: 'shell_line', path: 'references/x.md', key: null }),
      ]);
    });

    it('finds the skills beside a large agents folder', async () => {
      const files: Record<string, string> = { 'skills/review/SKILL.md': skillFile('review') };
      for (let index = 0; index < 150; index += 1) {
        files[`agents/a${index}/AGENT.md`] =
          `---\nname: a${index}\ndescription: d\nprovider: codex\n---\nx\n`;
        files[`agents/a${index}/notes.md`] = '# Notes\n';
      }
      await connectedWith('wide-agents', files);

      expect(names((await listSkills()).body)).toEqual(['review']);
    });

    it('bounds the list at 200 skill folders and says so, and still shows one beyond them', async () => {
      const files: Record<string, string> = {};
      for (let index = 0; index < 201; index += 1) {
        const name = `skill-${String(index).padStart(3, '0')}`;
        files[`skills/${name}/SKILL.md`] = skillFile(name);
      }
      await connectedWith('hundreds', files);

      const response = await listSkills();

      expect(response.status).toBe(200);
      expect(response.body.truncated).toBe(true);
      expect(response.body.skills).toHaveLength(200);
      expect((response.body.skills as ListedSkill[]).every((skill) => skill.valid)).toBe(true);
      const beyond = await getSkill('skill-200');
      expect(beyond.status).toBe(200);
      expect(beyond.body.valid).toBe(true);
    });

    it('reflects a fetch that brings new commits without another action', async () => {
      const { fixture, projectId, commit } = await connectedWith('fetching', {
        'skills/review/SKILL.md': skillFile('review'),
      });
      expect((await listSkills()).body.commit).toBe(commit);
      const next = pushFiles(fixture, 'dev', commit, {
        'skills/review/SKILL.md': skillFile('review'),
        'skills/planner/SKILL.md': skillFile('planner'),
      });

      const fetched = await asOperator(http().post(`/api/projects/${projectId}/repository/fetch`));
      expect(fetched.status).toBe(202);
      await settled(projectId);
      const response = await listSkills();

      expect(response.body.commit).toBe(next);
      expect(names(response.body)).toEqual(['planner', 'review']);
    });

    it('shows a skill in detail with its instructions as written, and its files with sizes', async () => {
      const instructions = '# Heading\n\n<script>alert(1)</script> and [a link](https://x.test)\n';
      const { commit } = await connectedWith('detail', {
        'skills/review/SKILL.md': skillFile('review', '', instructions),
        'skills/review/references/guide.md': '# Guide\n',
        'skills/broken/SKILL.md': '---\nname: broken\n---\nx\n',
      });

      const response = await getSkill('review');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        commit,
        repository: { state: 'ready', note: null },
        name: 'review',
        description: 'Does the review work',
        valid: true,
        problems: [],
        instructions,
        files: [
          { path: 'SKILL.md', size: Buffer.byteLength(skillFile('review', '', instructions)) },
          { path: 'references/guide.md', size: 8 },
        ],
        usedBy: [],
      });
      const broken = await getSkill('broken');
      expect(broken.body).toMatchObject({ valid: false, instructions: '', description: null });
      expect(broken.body.problems.length).toBeGreaterThan(0);
    });

    it('names the agents that list a skill, valid or not, sorted, and none for an unused skill', async () => {
      const agent = (name: string, extra: string) =>
        `---\nname: ${name}\ndescription: d\nprovider: codex\n${extra}---\nx\n`;
      await connectedWith('used-by', {
        'skills/review/SKILL.md': skillFile('review'),
        'skills/unused/SKILL.md': skillFile('unused'),
        'agents/zed/AGENT.md': agent('zed', 'skills: [review]\n'),
        'agents/alpha/AGENT.md': agent('alpha', 'skills: [review]\ncolour: red\n'),
        'agents/plain/AGENT.md': agent('plain', ''),
      });

      expect((await getSkill('review')).body.usedBy).toEqual(['alpha', 'zed']);
      expect((await getSkill('unused')).body.usedBy).toEqual([]);
    });

    it('answers a 404 problem for an unknown name and for names that are not skill names', async () => {
      await connectedWith('names', { 'skills/review/SKILL.md': skillFile('review') });

      const unknown = await getSkill('nope');
      expect(unknown.status).toBe(404);
      expect(unknown.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(problemDetailsSchema.safeParse(unknown.body).success).toBe(true);
      expect(unknown.body.type).toBe(NOT_FOUND);

      for (const encoded of ['a%20b', '%3Cscript%3E', 'A', '-a', 'a'.repeat(65)]) {
        const response = await getSkill(encoded);
        expect(response.status, encoded).toBe(404);
        expect(response.body.type, encoded).toBe(NOT_FOUND);
      }
      for (const encoded of ['%2e%2e', 'a%2Fb', '..%2F..%2Fetc%2Fpasswd']) {
        expect((await getSkill(encoded)).status, encoded).toBe(404);
      }
    });
  });
});
