// `pnpm e2e:smoke`: the walking-skeleton smoke test (Story #16), the same locally and in CI.
//
// 1. Starts throwaway PostgreSQL and Redis containers (Testcontainers; needs Docker) and
//    applies the committed migrations.
// 2. Generates a random throwaway operator password for this run and hashes it with the
//    API's documented helper (`auth:hash-password`, password on stdin); neither is stored
//    anywhere. The password reaches Playwright through the environment only.
// 3. Builds the packages, the API and the web app (production builds), then starts them:
//    web on http://localhost:$E2E_WEB_PORT (default 4500), API on 127.0.0.1:$E2E_API_PORT
//    (default 4501), with the web build proxying same-origin /api to the API (opt-in rules:
//    README.md, "Web /api proxy").
//    The API gets a throwaway data directory (STUDIO_DATA_DIR) in the OS temp directory.
// 4. Runs Playwright (tests/e2e/playwright.config.ts), then always stops the servers and
//    containers and removes the data directory.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4500);
const API_PORT = Number(process.env.E2E_API_PORT ?? 4501);
const STUDIO_ORIGIN = `http://localhost:${WEB_PORT}`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const READY_TIMEOUT_MS = 90_000;

const cleanups = [];
let interrupted = false;

/** Runs a command to completion in the repo root; throws on a non-zero exit. */
function run(command, args, env = {}) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

/** Starts a long-running server; it is stopped (with its child processes) on cleanup. */
function startServer(name, command, args, env) {
  console.log(`\n[e2e] starting ${name}: ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ...env },
    detached: process.platform !== 'win32',
  });
  let exited = false;
  child.on('exit', (code, signal) => {
    exited = true;
    if (!interrupted) console.log(`[e2e] ${name} exited (code ${code}, signal ${signal})`);
  });
  cleanups.push(async () => {
    if (exited) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
    for (let i = 0; i < 50 && !exited; i++) await delay(100);
  });
  return child;
}

/**
 * Hashes the operator password through the API's public helper script rather than importing
 * its built internals: the password goes in on stdin, only the hash comes back on stdout.
 */
function hashOperatorPassword(password) {
  const result = spawnSync(
    'pnpm',
    ['--silent', '--filter', '@agentic-studio/api', 'run', 'auth:hash-password'],
    {
      cwd: ROOT,
      input: `${password}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    },
  );
  const hash = result.stdout?.trim().split(/\r?\n/).pop() ?? '';
  if (result.status !== 0 || !hash.startsWith('$argon2id$')) {
    throw new Error(`auth:hash-password failed with exit code ${result.status}`);
  }
  return hash;
}

async function waitUntilReady(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await delay(500);
  }
  throw new Error(`${url} was not ready within ${READY_TIMEOUT_MS / 1000}s`);
}

async function cleanup() {
  interrupted = true;
  for (const step of cleanups.reverse()) {
    try {
      await step();
    } catch (error) {
      console.error('[e2e] cleanup step failed:', error);
    }
  }
}

async function main() {
  run('pnpm', ['exec', 'tsc', '-p', 'tests/e2e']);
  run('pnpm', ['run', 'build:packages']);
  run('pnpm', ['--filter', '@agentic-studio/api', 'run', 'build']);
  const webProxyEnv = { STUDIO_WEB_API_PROXY: 'true', API_ORIGIN };
  run('pnpm', ['--filter', '@agentic-studio/web', 'run', 'build'], webProxyEnv);

  // Imported after the builds: they resolve to the freshly built dist/ output.
  const { startPostgres, startRedis } = await import('@agentic-studio/testing');
  const { deployMigrations } = await import('@agentic-studio/database/migrations');

  console.log('\n[e2e] starting PostgreSQL and Redis (Testcontainers)');
  const [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  cleanups.push(
    () => postgres.stop(),
    () => redis.stop(),
  );
  await deployMigrations(postgres.url);

  // Throwaway data directory (STUDIO_DATA_DIR) outside the repository, removed afterwards.
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-e2e-data-'));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));

  const operatorPassword = randomBytes(24).toString('base64url');
  const serverEnv = {
    NODE_ENV: 'production',
    DATABASE_URL: postgres.url,
    REDIS_URL: redis.url,
    API_HOST: '127.0.0.1',
    API_PORT: String(API_PORT),
    API_ORIGIN,
    STUDIO_ORIGIN,
    API_TRUSTED_PROXIES: '',
    STUDIO_OPERATOR_PASSWORD_HASH: hashOperatorPassword(operatorPassword),
    STUDIO_DATA_DIR: dataDir,
  };

  startServer('api', process.execPath, ['apps/api/dist/main.js'], serverEnv);
  await waitUntilReady(`${API_ORIGIN}/api/health`);
  startServer(
    'web',
    process.execPath,
    [
      'apps/web/node_modules/next/dist/bin/next',
      'start',
      'apps/web',
      '-H',
      '127.0.0.1',
      '-p',
      String(WEB_PORT),
    ],
    webProxyEnv,
  );
  // Through the web origin: proves the web server is up and proxies /api to the API.
  await waitUntilReady(`http://127.0.0.1:${WEB_PORT}/api/health`);

  run('pnpm', ['exec', 'playwright', 'test', '-c', 'tests/e2e/playwright.config.ts'], {
    E2E_BASE_URL: STUDIO_ORIGIN,
    E2E_OPERATOR_PASSWORD: operatorPassword,
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void cleanup().then(() => process.exit(130));
  });
}

try {
  await main();
  console.log('\n[e2e] smoke test passed');
} catch (error) {
  console.error(`\n[e2e] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
