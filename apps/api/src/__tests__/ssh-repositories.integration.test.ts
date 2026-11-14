import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { AppModule } from '../app.module.js';
import type { AppConfig } from '../platform/config/config.js';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import { SECRET_STORE, SecretNotFoundError, type SecretStore } from '../platform/secrets/index.js';
import {
  signIn,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// Story #62, main seam: the real app over HTTP (PostgreSQL and Redis via Testcontainers, the
// real job queue, the real Git adapter) against throwaway OpenSSH + Git servers built from the
// Git adapter's fixture (#59). Every key, host key and known_hosts entry is generated at run
// time; nothing is committed. Linux only (CI runs it; the guard at the end fails CI if it was
// skipped). Playwright does not cover SSH: these tests are the end-to-end evidence.

const linux = process.platform === 'linux';
const SERVER_CONTEXT = join(
  import.meta.dirname,
  '../modules/projects/infrastructure/adapters/git/__tests__/fixtures/ssh-server',
);
const PROBLEM = 'urn:agentic-studio:problem:';
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
/** Studio's explanation leads a host_key_mismatch detail, then the redacted Git output. */
const HOST_KEY_CHANGED =
  /^The Git host's key changed\. .*disconnect the repository and connect it again\.\n\n\S/s;

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface KeyPair {
  privateKey: string;
  /** `<type> <base64>`. */
  publicKey: string;
}

/** A throwaway ed25519 key pair, generated for this run only. */
async function generateKeyPair(dir: string, name: string): Promise<KeyPair> {
  const path = join(dir, name);
  const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', path]);
  if (result.status !== 0) throw new Error(`ssh-keygen failed: ${String(result.stderr)}`);
  const [type, data] = (await readFile(`${path}.pub`, 'utf8')).trim().split(' ');
  return { privateKey: await readFile(path, 'utf8'), publicKey: `${type} ${data}` };
}

function fingerprintOf(publicKey: string): string {
  const data = publicKey.split(' ')[1]!;
  const digest = createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/** An SSH + Git server presenting `hostKey`, with no authorized key yet. */
async function startServer(hostKey: KeyPair): Promise<StartedTestContainer> {
  const image = await GenericContainer.fromDockerfile(SERVER_CONTEXT).build(
    'agentic-studio-test-ssh-git:59',
    { deleteOnExit: false },
  );
  return image
    .withCopyContentToContainer([
      { content: hostKey.privateKey, target: '/etc/ssh/test_host_ed25519_key', mode: 0o600 },
      { content: '', target: '/etc/ssh/authorized_keys/git', mode: 0o644 },
    ])
    .withExposedPorts(22)
    .withWaitStrategy(Wait.forLogMessage(/Server listening on/))
    .start();
}

const urlOf = (server: StartedTestContainer) =>
  `ssh://git@${server.getHost()}:${server.getMappedPort(22)}/srv/git/repo.git`;
const knownHostNameOf = (server: StartedTestContainer) =>
  `[${server.getHost().toLowerCase()}]:${server.getMappedPort(22)}`;

/** Adds a Deploy key on the "Git host", as the operator would. */
async function authorize(server: StartedTestContainer, publicKey: string): Promise<void> {
  const result = await server.exec([
    'sh',
    '-c',
    `printf '%s\\n' "$0" >> /etc/ssh/authorized_keys/git`,
    publicKey,
  ]);
  expect(result.exitCode).toBe(0);
}

describe.runIf(linux)('SSH repositories with a Deploy key (HTTP + SSH servers)', () => {
  let services: StudioServices;
  let dataDir: string;
  let keysDir: string;
  let app: INestApplication;
  let cookie: string;
  /** Listed in STUDIO_SSH_KNOWN_HOSTS with its real host key. */
  let listed: StartedTestContainer;
  /** Not listed: Studio asks the operator about it. */
  let unlisted: StartedTestContainer;
  /** Listed with the wrong key, and the host an unlisted Repository "moves" to. */
  let impostor: StartedTestContainer;
  let listedKey: KeyPair;
  let unlistedKey: KeyPair;
  let impostorKey: KeyPair;

  /** Every response body and log line of the app, for the leak test. */
  const responses: string[] = [];
  const logs: string[] = [];
  /** Every Deploy key's private half Studio generated, read back from the secret store. */
  const privateKeys = new Set<string>();

  const capture =
    (level: string) =>
    (message: unknown, ...rest: unknown[]) => {
      logs.push(`${level} ${format(message, ...rest)}`);
    };
  const logger: LoggerService = {
    log: capture('log'),
    error: capture('error'),
    warn: capture('warn'),
    debug: capture('debug'),
    verbose: capture('verbose'),
    fatal: capture('fatal'),
  };

  const server = () => app.getHttpServer();
  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);

  async function recorded(pending: request.Test): Promise<request.Response> {
    const response = await pending;
    responses.push(response.text ?? '');
    return response;
  }

  async function startApp(
    config: AppConfig,
    options: Parameters<typeof AppModule.register>[1] = {},
  ) {
    app = await buildApp(AppModule.register(config, options), { logger });
    await app.init();
    cookie = await signIn(app);
  }

  async function createProject(name: string): Promise<string> {
    const response = await recorded(
      request(server())
        .post('/api/projects')
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
        .send({ name }),
    );
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  const secretStore = () => app.get<SecretStore>(SECRET_STORE);

  /** The secret store reference the Repository holds (never a key). */
  async function deployKeyRef(projectId: string): Promise<string> {
    const [row] = await db().$queryRaw<{ ref: string }[]>`
      SELECT deploy_key_secret_id::text AS ref FROM repositories WHERE project_id = ${projectId}::uuid`;
    return row!.ref;
  }

  /** Connects over SSH and keeps the generated private key for the leak test. */
  async function connect(projectId: string, url: string) {
    const response = await recorded(
      request(server())
        .post(`/api/projects/${projectId}/repository`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
        .send({ url, integrationBranch: 'main' }),
    );
    if (response.status === 201) {
      privateKeys.add(await secretStore().get(await deployKeyRef(projectId)));
    }
    return response;
  }

  const verify = (projectId: string, body: object = {}) =>
    recorded(
      request(server())
        .post(`/api/projects/${projectId}/repository/verify`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
        .send(body),
    );
  const getRepository = (projectId: string) =>
    recorded(request(server()).get(`/api/projects/${projectId}/repository`).set('Cookie', cookie));
  const fetchRepository = (projectId: string) =>
    recorded(
      request(server())
        .post(`/api/projects/${projectId}/repository/fetch`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie }),
    );
  const disconnect = (projectId: string) =>
    recorded(
      request(server())
        .delete(`/api/projects/${projectId}/repository`)
        .set({ Origin: STUDIO_ORIGIN, Cookie: cookie }),
    );

  async function settled(projectId: string, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await getRepository(projectId);
      expect(response.status).toBe(200);
      if (!['connecting', 'fetching'].includes(response.body.state)) return response.body;
      if (Date.now() > deadline) throw new Error(`the repository stayed ${response.body.state}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  function expectProblem(response: request.Response, status: number, type?: string) {
    expect(response.status).toBe(status);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
    if (type) expect(response.body.type).toBe(`${PROBLEM}${type}`);
  }

  beforeAll(async () => {
    keysDir = await mkdtemp(join(tmpdir(), 'studio-ssh-http-keys-'));
    [listedKey, unlistedKey, impostorKey] = await Promise.all(
      ['listed', 'unlisted', 'impostor'].map((name) => generateKeyPair(keysDir, name)),
    );
    [services, listed, unlisted, impostor] = await Promise.all([
      startStudioServices(),
      startServer(listedKey),
      startServer(unlistedKey),
      startServer(impostorKey),
    ]);
    dataDir = await mkdtemp(join(tmpdir(), 'studio-ssh-http-'));
    services.config = {
      ...services.config,
      dataDir,
      // The SSH servers and closed ports are on the Docker host's loopback: an explicit opt-in.
      gitAllowPrivateRemotes: true,
      sshKnownHosts: [
        { hosts: [knownHostNameOf(listed)], key: listedKey.publicKey },
        // A stale or wrong entry: the host presents another key.
        { hosts: [knownHostNameOf(impostor)], key: listedKey.publicKey },
      ],
    };
    await startApp(services.config);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await Promise.all([services?.stop(), listed?.stop(), unlisted?.stop(), impostor?.stop()]);
    for (const dir of [dataDir, keysDir]) if (dir) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Test isolation only; assertions use the API and the secret store's port.
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
  });

  it('connects over SSH: 201 awaiting_key with the public key, nothing cloned yet', async () => {
    const id = await createProject('Acme Shop');

    const response = await connect(id, urlOf(listed));

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      state: 'awaiting_key',
      url: urlOf(listed),
      integrationBranch: 'main',
      hasClone: false,
      publicKey: expect.stringMatching(/^ssh-ed25519 [A-Za-z0-9+/]+=* studio-Acme-Shop$/),
    });
    expect((await getRepository(id)).body).toEqual(response.body);
    // The private key is in the secret store only; the Repository holds its reference.
    expect(await secretStore().get(await deployKeyRef(id))).toMatch(
      /^-----BEGIN OPENSSH PRIVATE KEY-----\n/,
    );
  });

  it('listed host: key not added → auth_failed; added → Retry with the same key → ready; Fetch works', async () => {
    const id = await createProject('Listed');
    const { publicKey } = (await connect(id, urlOf(listed))).body;

    const started = await verify(id);
    expect(started.status).toBe(202);
    expect(started.body.state).toBe('connecting');
    const failed = await settled(id);
    expect(failed).toMatchObject({
      state: 'failed',
      hasClone: false,
      publicKey,
      failure: { code: 'auth_failed' },
    });

    await authorize(listed, publicKey);
    expect((await verify(id)).status).toBe(202);
    const ready = await settled(id);
    expect(ready).toMatchObject({ state: 'ready', hasClone: true, publicKey });
    expect(ready.headSha).toMatch(/^[\da-f]{40}$/);
    expect(ready).not.toHaveProperty('hostKeyFingerprint');

    expect((await fetchRepository(id)).status).toBe(202);
    expect(await settled(id)).toMatchObject({ state: 'ready', headSha: ready.headSha, publicKey });
  });

  it('unlisted host: the operator confirms the fingerprint (422 for another), then it clones', async () => {
    const id = await createProject('Unlisted');
    const { publicKey } = (await connect(id, urlOf(unlisted))).body;
    await authorize(unlisted, publicKey);

    const asked = await verify(id);
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({
      state: 'awaiting_host_key',
      hostKeyFingerprint: fingerprintOf(unlistedKey.publicKey),
    });
    expect(asked.body.hostKeyFingerprint).toMatch(FINGERPRINT);

    const wrong = await verify(id, {
      acceptHostKeyFingerprint: fingerprintOf(listedKey.publicKey),
    });
    expectProblem(wrong, 422);
    expect(wrong.body.errors).toEqual([
      { path: 'acceptHostKeyFingerprint', message: expect.any(String) },
    ]);
    expect((await getRepository(id)).body.state).toBe('awaiting_host_key');

    const confirmed = await verify(id, { acceptHostKeyFingerprint: asked.body.hostKeyFingerprint });
    expect(confirmed.status).toBe(202);
    expect(confirmed.body.state).toBe('connecting');
    expect(await settled(id)).toMatchObject({
      state: 'ready',
      hostKeyFingerprint: fingerprintOf(unlistedKey.publicKey),
    });

    // The host key changes between connect and fetch (test setup: the remote moves to a host
    // presenting another key): host_key_mismatch, never accepted, the Clone is kept.
    await db().$executeRaw`
      UPDATE repositories SET url = ${urlOf(impostor)} WHERE project_id = ${id}::uuid`;
    expect((await fetchRepository(id)).status).toBe(202);
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      hasClone: true,
      failure: { code: 'host_key_mismatch', detail: expect.stringMatching(HOST_KEY_CHANGED) },
      hostKeyFingerprint: fingerprintOf(unlistedKey.publicKey),
    });
  });

  it('a listed host presenting another key fails with host_key_mismatch on connect', async () => {
    const id = await createProject('Impostor');
    const { publicKey } = (await connect(id, urlOf(impostor))).body;
    await authorize(impostor, publicKey);

    expect((await verify(id)).body.state).toBe('connecting');
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      hasClone: false,
      failure: { code: 'host_key_mismatch', detail: expect.stringMatching(HOST_KEY_CHANGED) },
    });
  });

  it('a host presenting another key than the pinned one fails with host_key_mismatch on a Retry (#72)', async () => {
    const id = await createProject('Pinned');
    const { publicKey } = (await connect(id, urlOf(unlisted))).body;
    // The operator confirms the host key, but the Deploy key is not added yet: auth_failed,
    // with the host key pinned.
    const asked = await verify(id);
    await verify(id, { acceptHostKeyFingerprint: asked.body.hostKeyFingerprint });
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      failure: { code: 'auth_failed' },
      hostKeyFingerprint: fingerprintOf(unlistedKey.publicKey),
    });
    // The host's key changes (test setup: the pinned key becomes another one, which is what
    // Studio sees when the host presents a key other than the pinned one).
    await db().$executeRaw`
      UPDATE repositories SET pinned_host_key = ${impostorKey.publicKey} WHERE project_id = ${id}::uuid`;
    await authorize(unlisted, publicKey);

    // Retry over the same host keeps the Deploy key and the pinned host key, so verify clones
    // at once, against the pinned key only.
    const retry = await connect(id, urlOf(unlisted));
    expect(retry.body).toMatchObject({
      state: 'awaiting_key',
      publicKey,
      hostKeyFingerprint: fingerprintOf(impostorKey.publicKey),
    });
    expect((await verify(id)).body.state).toBe('connecting');
    expect(await settled(id)).toMatchObject({
      state: 'failed',
      hasClone: false,
      failure: { code: 'host_key_mismatch', detail: expect.stringMatching(HOST_KEY_CHANGED) },
      hostKeyFingerprint: fingerprintOf(impostorKey.publicKey),
    });
  });

  it('refuses verify outside the verification states (409) and for no repository (404)', async () => {
    const id = await createProject('Refusals');
    expectProblem(await verify(id), 404, 'no-repository');
    await connect(id, urlOf(unlisted));
    expectProblem(
      await verify(id, { acceptHostKeyFingerprint: fingerprintOf(unlistedKey.publicKey) }),
      409,
      'repository-not-verifiable',
    );
    expectProblem(await verify(id, { acceptHostKeyFingerprint: '' }), 422);
  });

  it('disconnect removes the private key (no secret left); connecting again generates a new key pair', async () => {
    const id = await createProject('Reconnect');
    const first = (await connect(id, urlOf(unlisted))).body;
    await verify(id);
    const ref = await deployKeyRef(id);

    expect((await disconnect(id)).status).toBe(204);
    await expect(secretStore().get(ref)).rejects.toBeInstanceOf(SecretNotFoundError);
    expectProblem(await getRepository(id), 404, 'no-repository');

    const second = await connect(id, urlOf(unlisted));
    expect(second.status).toBe(201);
    expect(second.body.publicKey).not.toBe(first.publicKey);
    expect(second.body).not.toHaveProperty('hostKeyFingerprint');
  });

  // Self-contained: it drives every state and failure path itself, then checks everything the
  // app sent back or logged meanwhile.
  it('never returns or logs private key material, in any state or failure', async () => {
    responses.length = 0;
    logs.length = 0;
    privateKeys.clear();
    const clonesDir = join(dataDir, 'clones');

    // awaiting_key → awaiting_host_key → 422 → confirmed → ready → fetch → ready; 409 after.
    const a = await createProject('Leak unlisted');
    const keyA = (await connect(a, urlOf(unlisted))).body.publicKey as string;
    await authorize(unlisted, keyA);
    const asked = await verify(a);
    expect(asked.body.state).toBe('awaiting_host_key');
    expectProblem(
      await verify(a, { acceptHostKeyFingerprint: fingerprintOf(listedKey.publicKey) }),
      422,
    );
    expect(
      (await verify(a, { acceptHostKeyFingerprint: asked.body.hostKeyFingerprint })).status,
    ).toBe(202);
    expect((await settled(a)).state).toBe('ready');
    expect((await fetchRepository(a)).status).toBe(202);
    expect((await settled(a)).state).toBe('ready');
    expectProblem(await verify(a), 409, 'repository-not-verifiable');

    // auth_failed (the key is not added on a listed host).
    const b = await createProject('Leak auth');
    await connect(b, urlOf(listed));
    await verify(b);
    expect(await settled(b)).toMatchObject({ failure: { code: 'auth_failed' } });

    // A secret-store failure in the clone job: the private key is gone from the store.
    await secretStore().delete(await deployKeyRef(b));
    expect((await verify(b)).status).toBe(202);
    expect(await settled(b)).toMatchObject({ state: 'failed', failure: { code: 'unknown' } });
    expect(logs.join('\n')).toMatch(/SecretNotFoundError/);

    // host_key_mismatch (a listed host presenting another key).
    const c = await createProject('Leak mismatch');
    await connect(c, urlOf(impostor));
    await verify(c);
    expect(await settled(c)).toMatchObject({ failure: { code: 'host_key_mismatch' } });

    // host_unreachable while retrieving the host key (nothing listens).
    const d = await createProject('Leak unreachable');
    await connect(d, `ssh://git@127.0.0.1:${await closedPort()}/srv/git/repo.git`);
    expect((await verify(d)).body).toMatchObject({
      state: 'failed',
      failure: { code: 'host_unreachable' },
    });

    // 503: the queue cannot schedule the clone (test setup: a key of the wrong type where the
    // job's hash goes makes every Redis call on it fail). This relies on the platform queue's
    // BullMQ key layout (`<prefix>:<queue>:<job id>`), acceptable in a test (#72, won't fix).
    const redis = new Redis(services.config.redisUrl);
    const jobKey = `studio:queue:repository-git:repository-${c}`;
    try {
      await redis.set(jobKey, 'not a job');
      const unavailable = await verify(c);
      expect(unavailable.status).toBe(503);
      // The generic 5xx body, unchanged by the switch to serviceUnavailable() (Issue #70).
      expect(unavailable.body).toEqual({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'An unexpected error occurred.',
        correlationId: expect.any(String),
      });
    } finally {
      await redis.del(jobKey);
      redis.disconnect();
    }

    // 501 on a host that is not Linux, for connect and verify.
    await app.close();
    await startApp(services.config, { projects: { gitSettings: { platform: 'win32' } } });
    try {
      const e = await createProject('Leak windows');
      expectProblem(await connect(e, `${urlOf(unlisted).replace('repo.git', 'other.git')}`), 501);
      expectProblem(await verify(b), 501, 'unsupported-platform');
    } finally {
      await app.close();
      await startApp(services.config);
    }

    // A disconnect whose cleanup is pending (logged), then completed.
    await rename(clonesDir, `${clonesDir}-real`);
    await symlink(`${clonesDir}-real`, clonesDir);
    try {
      expect((await disconnect(a)).status).toBe(202);
      expect(logs.join('\n')).toMatch(/stays disconnecting/);
    } finally {
      await rm(clonesDir, { force: true });
      await rename(`${clonesDir}-real`, clonesDir);
    }
    for (const id of [a, b, c, d]) expect((await disconnect(id)).status).toBe(204);

    expect(privateKeys.size).toBe(4);
    const haystacks = [...responses, ...logs];
    const fragments = [...privateKeys].flatMap((key) =>
      key
        .split('\n')
        .filter((line) => line !== '' && !line.startsWith('-----'))
        .map((line) => line.trim())
        // A short last line could occur anywhere by chance; full lines cannot.
        .filter((line) => line.length >= 16),
    );
    expect(fragments.length).toBeGreaterThan(0);
    for (const text of haystacks) {
      expect(text).not.toMatch(/PRIVATE KEY/);
      for (const fragment of fragments) expect(text.includes(fragment)).toBe(false);
    }
  }, 180_000);
});

// Guard against a silent skip: in CI these Linux-only cases must run.
it.runIf(process.env.GITHUB_ACTIONS === 'true')(
  'runs the SSH repository cases in CI (Linux)',
  () => {
    expect(process.platform).toBe('linux');
  },
);
