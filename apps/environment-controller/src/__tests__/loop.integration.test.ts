import { createDatabaseClient, type DatabaseClient } from '@agentic-studio/database';
import { deployMigrations } from '@agentic-studio/database/migrations';
import { startPostgres, startRedis, type TestService } from '@agentic-studio/testing';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildController, type BuiltController } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { JsonLineLogger } from '../logger.js';
import { type ComposeRepository, createComposeRepository } from './fixtures/git-fixture.js';

// The real controller loop against the production-built Studio API, reached over HTTP only, with
// the fake runtime. An operation is created with SQL, as no route creates one yet.

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const API_MAIN = join(ROOT, 'apps', 'api', 'dist', 'main.js');
const HASH_PASSWORD = join(ROOT, 'apps', 'api', 'dist', 'platform', 'auth', 'hash-password.js');
const STUDIO_ORIGIN = 'http://localhost:4300';
// Throwaway values generated per run; none is committed.
const OPERATOR_PASSWORD = randomBytes(18).toString('base64');
const CONTROLLER_TOKEN = randomBytes(32).toString('base64');
const ENVIRONMENT_VALUE = `pw-${randomBytes(9).toString('hex')}`;
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n    expose:\n      - "3000"\n';
const PRIVILEGED = 'services:\n  web:\n    image: nginx:1.27\n    privileged: true\n';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await delay(100);
  }
}

describe.skipIf(process.platform !== 'linux')(
  'environment controller loop against the real API',
  () => {
    let postgres: TestService;
    let redis: TestService;
    let db: DatabaseClient;
    let api: ChildProcess;
    let apiUrl: string;
    let cookie: string;
    let dataDir: string;
    let fixtures: string;
    let controllerDataDir: string;
    let started: BuiltController | undefined;
    let repository: ComposeRepository;
    let privilegedRepository: ComposeRepository;
    const journal: string[] = [];

    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${apiUrl}${path}`, {
        ...init,
        headers: {
          Origin: STUDIO_ORIGIN,
          Cookie: cookie,
          'Content-Type': 'application/json',
          ...init.headers,
        },
      });

    async function readyProject(repo: ComposeRepository): Promise<string> {
      const created = await call('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: `Project ${randomUUID()}` }),
      });
      expect(created.status).toBe(201);
      const projectId = ((await created.json()) as { id: string }).id;
      const connected = await call(`/api/projects/${projectId}/repository`, {
        method: 'POST',
        body: JSON.stringify({ url: repo.url, integrationBranch: 'dev' }),
      });
      expect(connected.status).toBe(201);
      await until(
        async () =>
          (
            (await (await call(`/api/projects/${projectId}/repository`)).json()) as {
              state: string;
            }
          ).state,
        (state) => state === 'ready' || state === 'failed',
      ).then((state) => expect(state).toBe('ready'));
      return projectId;
    }

    const insertBuild = (projectId: string, commit: string) =>
      db.previewOperation.create({
        data: {
          projectId,
          kind: 'build',
          status: 'requested',
          commit,
          composeFile: 'compose.yaml',
          service: 'web',
          port: 3000,
          memoryMiB: 1024,
          cpuPercent: 100,
          tasksMax: 512,
          buildMinutes: 20,
        },
      });

    const operation = (id: string) => db.previewOperation.findUniqueOrThrow({ where: { id } });
    const finished = (id: string) =>
      until(
        () => operation(id),
        (row) => row.status === 'succeeded' || row.status === 'failed',
      );

    beforeAll(async () => {
      if (!existsSync(API_MAIN)) throw new Error('Build the API first: apps/api/dist is missing.');
      [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
      await deployMigrations(postgres.url);
      db = createDatabaseClient(postgres.url);

      const hashed = spawnSync(process.execPath, [HASH_PASSWORD], {
        input: `${OPERATOR_PASSWORD}\n`,
        encoding: 'utf8',
      });
      const passwordHash = hashed.stdout.trim().split(/\r?\n/).pop() ?? '';
      if (hashed.status !== 0 || !passwordHash.startsWith('$argon2id$'))
        throw new Error('hash-password failed');

      dataDir = mkdtempSync(join(tmpdir(), 'controller-it-api-'));
      fixtures = mkdtempSync(join(tmpdir(), 'controller-it-git-'));
      controllerDataDir = mkdtempSync(join(tmpdir(), 'controller-it-data-'));
      repository = createComposeRepository(fixtures, 'shop', {
        'compose.yaml': COMPOSE,
        'src/app.js': 'console.log(1);\n',
      });
      privilegedRepository = createComposeRepository(fixtures, 'bad', {
        'compose.yaml': PRIVILEGED,
      });

      const port = await freePort();
      apiUrl = `http://127.0.0.1:${port}`;
      api = spawn(process.execPath, [API_MAIN], {
        cwd: join(ROOT, 'apps', 'api'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          STUDIO_GIT_ALLOW_FILE_REMOTES: 'true',
          STUDIO_GIT_ALLOW_PRIVATE_REMOTES: 'true',
          DATABASE_URL: postgres.url,
          REDIS_URL: redis.url,
          API_PORT: String(port),
          API_HOST: '127.0.0.1',
          STUDIO_ORIGIN,
          STUDIO_OPERATOR_PASSWORD_HASH: passwordHash,
          STUDIO_SECRETS_KEY: randomBytes(32).toString('base64'),
          STUDIO_DATA_DIR: dataDir,
          STUDIO_WORKER_TOKEN: randomBytes(32).toString('base64'),
          STUDIO_CONTROLLER_TOKEN: CONTROLLER_TOKEN,
        },
      });
      api.stdout!.resume();
      api.stderr!.setEncoding('utf8').on('data', (chunk: string) => process.stderr.write(chunk));
      await until(
        () =>
          fetch(`${apiUrl}/api/health`)
            .then((response) => response.status)
            .catch(() => 0),
        (status) => status === 200,
        90_000,
      );
      const login = await fetch(`${apiUrl}/api/auth/login`, {
        method: 'POST',
        headers: { Origin: STUDIO_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: OPERATOR_PASSWORD }),
      });
      const session = login.headers
        .getSetCookie()
        .find((value) => value.startsWith('studio_session='));
      if (login.status !== 200 || !session) throw new Error(`login failed: ${login.status}`);
      cookie = session.split(';')[0]!;

      const config = loadConfig({
        STUDIO_API_URL: apiUrl,
        STUDIO_CONTROLLER_TOKEN: CONTROLLER_TOKEN,
        STUDIO_CONTROLLER_ENVIRONMENT: 'test',
        STUDIO_CONTROLLER_RUNTIME: 'fake',
        STUDIO_CONTROLLER_DATA_DIR: controllerDataDir,
        STUDIO_CONTROLLER_POLL_MS: '100',
        STUDIO_CONTROLLER_HEARTBEAT_MS: '500',
        STUDIO_CONTROLLER_MIN_FREE_GB: '0',
      });
      started = await buildController(config, new JsonLineLogger((line) => journal.push(line)));
      void started.controller.run();
    });

    afterAll(async () => {
      await started?.controller.stop();
      await started?.runtime.runtime.close();
      if (api && api.exitCode === null) {
        const exited = new Promise((resolve) => api.once('exit', resolve));
        api.kill('SIGTERM');
        await exited;
      }
      await db?.$disconnect();
      await Promise.all([postgres?.stop(), redis?.stop()]);
      for (const path of [dataDir, fixtures, controllerDataDir])
        if (path) rmSync(path, { recursive: true, force: true });
    });

    it('builds a Preview from a SQL-inserted operation: succeeded, with redacted lines', async () => {
      const projectId = await readyProject(repository);
      const envFile = await call(`/api/projects/${projectId}/environment-file`, {
        method: 'PUT',
        body: JSON.stringify({
          path: 'preview.env',
          content: `DB_PASSWORD=${ENVIRONMENT_VALUE}\n`,
        }),
      });
      expect(envFile.status).toBe(200);

      const { id } = await insertBuild(projectId, repository.commit);
      const row = await finished(id);

      expect(row).toMatchObject({ status: 'succeeded', claimedBy: started!.controllerId });
      expect(row.result).toEqual({ services: [{ name: 'web', state: 'running' }] });
      const lines = await db.previewOperationLine.findMany({
        where: { operationId: id },
        orderBy: { seq: 'asc' },
      });
      const text = lines.map((line) => line.text);
      expect(text).toContain('fake build of web');
      expect(text.some((line) => line.startsWith('fake build: using DB_PASSWORD='))).toBe(true);
      expect(text.join('\n')).not.toContain(ENVIRONMENT_VALUE);
      expect(lines.map((line) => line.seq)).toEqual(lines.map((_, index) => index + 1));
      expect(journal.join('\n')).not.toContain(ENVIRONMENT_VALUE);
      expect(started!.runtime.fake!.bridges.open).toHaveLength(1);

      const stop = await db.previewOperation.create({
        data: { projectId, kind: 'stop', status: 'requested' },
      });
      expect(await finished(stop.id)).toMatchObject({ status: 'succeeded' });
      expect(started!.runtime.fake!.bridges.open).toHaveLength(0);
      expect(
        started!.runtime.fake!.events.filter((event) => event.startsWith('removeContainers')),
      ).toHaveLength(1);
    });

    it('refuses a stack the validation refuses, reporting the refusals', async () => {
      const projectId = await readyProject(privilegedRepository);
      const { id } = await insertBuild(projectId, privilegedRepository.commit);
      const row = await finished(id);
      expect(row).toMatchObject({ status: 'failed', failureCode: 'validation_refused' });
      expect(row.refusals).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'privileged' })]),
      );
    });

    it('fails a build whose commit the API cannot archive as source_unavailable', async () => {
      const projectId = await readyProject(
        createComposeRepository(fixtures, 'gone', { 'compose.yaml': COMPOSE }),
      );
      const { id } = await insertBuild(projectId, 'f'.repeat(40));
      const row = await finished(id);
      expect(row).toMatchObject({ status: 'failed', failureCode: 'source_unavailable' });
    });
  },
);
