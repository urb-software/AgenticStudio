// `pnpm e2e:smoke`: the walking-skeleton smoke test (Story #16), the same locally and in CI.
//
// 1. Starts throwaway PostgreSQL and Redis containers (Testcontainers; needs Docker) and
//    applies the committed migrations.
// 2. Generates a random throwaway operator password for this run and hashes it with the
//    API's documented helper (`auth:hash-password`, password on stdin); neither is stored
//    anywhere. The password reaches Playwright through the environment only. A throwaway
//    secret-store master key (STUDIO_SECRETS_KEY) is generated the same way, per run.
// 3. Builds the packages, the API and the web app (production builds), then starts them:
//    web on http://localhost:$E2E_WEB_PORT (default 4500), API on 127.0.0.1:$E2E_API_PORT
//    (default 4501), with the web build proxying same-origin /api to the API (opt-in rules:
//    README.md, "Web /api proxy").
//    The API gets a throwaway data directory (STUDIO_DATA_DIR) in the OS temp directory.
//    The API runs with NODE_ENV=test and STUDIO_GIT_ALLOW_FILE_REMOTES=true: the Git adapter's
//    test-only fixture-remote setting, which the API accepts only under NODE_ENV=test (#59).
//    Nothing else in the API reads NODE_ENV (Story #60, clarification 7).
// 4. On Linux, creates throwaway bare fixture Repositories with a `dev` branch (two per
//    Playwright project: one for the repository test, one for the Run test, since a remote
//    belongs to one project) in a temp directory, and starts the agent worker (#96; Linux only)
//    with the fake runner. The worker gets a clean environment: only STUDIO_API_URL, a worker
//    token generated for this run (the API gets the same STUDIO_WORKER_TOKEN), and the fake
//    runner mode in a test environment with both provider switches on (#101; no CLI is ever
//    spawned, and Studio refuses to start Runs until a worker reports them available); it refuses
//    to start if a Studio-side setting such as DATABASE_URL reaches it. Repository features
//    are Linux only: on other platforms the Git steps skip with a reason, and the smoke
//    checks the "unsupported platform" answer instead.
// 5. Runs Playwright (tests/e2e/playwright.config.ts). On Linux it then fails unless the
//    repository test and the Run test really ran and passed in every Playwright project (a
//    guard against a silent skip in CI). Always stops the servers and containers and removes the temp
//    directories.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4500);
const API_PORT = Number(process.env.E2E_API_PORT ?? 4501);
const STUDIO_ORIGIN = `http://localhost:${WEB_PORT}`;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const READY_TIMEOUT_MS = 90_000;
const LINUX = process.platform === 'linux';
/** The Playwright projects (tests/e2e/playwright.config.ts); each connects its own fixture. */
const PLAYWRIGHT_PROJECTS = ['desktop', 'phone'];
/** Titles of the smoke tests that need Linux (checked by the Linux guard). */
const LINUX_TESTS = [
  'operator connects a repository, fetches it, disconnects it and connects it again',
  'operator starts runs and follows them to their result',
];
/** Fixture Repositories per Playwright project: the repository test's and the Run test's. */
const FIXTURE_PREFIXES = ['', 'run-'];

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

/**
 * Starts a long-running server; it is stopped (with its child processes) on cleanup. With
 * `clean`, it gets `env` alone instead of this process's environment plus `env`.
 */
function startServer(name, command, args, env, { clean = false } = {}) {
  console.log(`\n[e2e] starting ${name}: ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: clean ? env : { ...process.env, ...env },
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

/** Runs the system `git` for a fixture, isolated from the host's Git configuration. */
function fixtureGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: cwd,
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Smoke Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Smoke Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  });
  if (result.status !== 0)
    throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Creates `<root>/<name>.git` for each Playwright project (and `run-<name>.git` for the Run
 * test), a bare Repository whose default branch is `main` and which has
 * a `dev` branch one commit ahead. Returns the directory URL the fixtures share.
 */
async function createFixtureRepositories(root) {
  const names = FIXTURE_PREFIXES.flatMap((prefix) =>
    PLAYWRIGHT_PROJECTS.map((project) => `${prefix}${project}`),
  );
  for (const name of names) {
    const work = join(root, `${name}-work`);
    await mkdir(work, { recursive: true });
    fixtureGit(work, ['init', '--quiet', '--template=', '--initial-branch=main']);
    await writeFile(join(work, 'README.md'), `# Smoke fixture (${name})\n`);
    fixtureGit(work, ['add', '--all']);
    fixtureGit(work, ['commit', '--quiet', '-m', 'initial']);
    fixtureGit(work, ['checkout', '--quiet', '-b', 'dev']);
    await writeFile(join(work, 'dev.txt'), 'dev\n');
    fixtureGit(work, ['add', '--all']);
    fixtureGit(work, ['commit', '--quiet', '-m', 'on dev']);
    fixtureGit(root, [
      'clone',
      '--quiet',
      '--bare',
      '--template=',
      work,
      join(root, `${name}.git`),
    ]);
    // A bare clone takes the work tree's current branch (dev) as HEAD; the default is main.
    fixtureGit(join(root, `${name}.git`), ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  return pathToFileURL(`${root}/`).href;
}

/**
 * Linux guard: each Linux-only test must have run (not skipped) and passed in every
 * Playwright project, so CI cannot pass with the Git or Run steps silently skipped.
 */
async function assertLinuxTestsRan(reportPath) {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  for (const title of LINUX_TESTS) assertTestRan(report, title);
}

function assertTestRan(report, title) {
  const outcomes = [];
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      if (spec.title !== title) continue;
      for (const test of spec.tests) {
        outcomes.push(`${test.projectName}:${test.results.at(-1)?.status ?? 'not run'}`);
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  const expected = PLAYWRIGHT_PROJECTS.map((name) => `${name}:passed`).sort();
  if (JSON.stringify(outcomes.sort()) !== JSON.stringify(expected)) {
    throw new Error(
      `the smoke test "${title}" must pass in ${PLAYWRIGHT_PROJECTS.join(' and ')} on Linux; ` +
        `got ${outcomes.length > 0 ? outcomes.join(', ') : 'no run'}`,
    );
  }
  console.log(`[e2e] guard: "${title}" passed in ${outcomes.length} projects`);
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
  if (LINUX) run('pnpm', ['--filter', '@agentic-studio/agent-worker', 'run', 'build']);
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

  // Throwaway fixture Repositories (Linux only) and the Playwright JSON report.
  const scratch = await mkdtemp(join(tmpdir(), 'studio-e2e-'));
  cleanups.push(() => rm(scratch, { recursive: true, force: true }));
  let fixtureBase = '';
  if (LINUX) {
    fixtureBase = await createFixtureRepositories(join(scratch, 'fixtures'));
    console.log(`[e2e] fixture repositories under ${fixtureBase}`);
  } else {
    console.log(
      `[e2e] Git steps skipped: repository features run on Linux only (this is ${process.platform}); ` +
        'the smoke checks the unsupported-platform answer instead.',
    );
  }
  const reportPath = join(scratch, 'playwright-report.json');

  const operatorPassword = randomBytes(24).toString('base64url');
  // The agent worker's token for this run only (at least 32 characters); never stored.
  const workerToken = randomBytes(32).toString('base64url');
  const serverEnv = {
    // The fixture-remote setting below is accepted only under NODE_ENV=test (#59).
    NODE_ENV: 'test',
    STUDIO_GIT_ALLOW_FILE_REMOTES: 'true',
    DATABASE_URL: postgres.url,
    REDIS_URL: redis.url,
    API_HOST: '127.0.0.1',
    API_PORT: String(API_PORT),
    API_ORIGIN,
    STUDIO_ORIGIN,
    API_TRUSTED_PROXIES: '',
    STUDIO_OPERATOR_PASSWORD_HASH: hashOperatorPassword(operatorPassword),
    STUDIO_SECRETS_KEY: randomBytes(32).toString('base64'),
    STUDIO_DATA_DIR: dataDir,
    STUDIO_WORKER_TOKEN: workerToken,
  };

  startServer('api', process.execPath, ['apps/api/dist/main.js'], serverEnv);
  await waitUntilReady(`${API_ORIGIN}/api/health`);
  if (LINUX) {
    // A clean environment on purpose: the worker must not see DATABASE_URL or any other
    // Studio-side setting (it refuses to start if it does). PATH only lets Node resolve tools.
    startServer(
      'agent-worker',
      process.execPath,
      ['apps/agent-worker/dist/main.js'],
      {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        STUDIO_API_URL: API_ORIGIN,
        STUDIO_WORKER_TOKEN: workerToken,
        STUDIO_WORKER_POLL_MS: '500',
        STUDIO_WORKER_HEARTBEAT_MS: '2000',
        // Fake runner, allowed only outside production; both providers on (Issue #101).
        STUDIO_WORKER_RUNNER: 'fake',
        STUDIO_WORKER_ENVIRONMENT: 'test',
        CLAUDE_CODE_ENABLED: 'true',
        CODEX_CLI_ENABLED: 'true',
      },
      { clean: true },
    );
  }
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

  run(
    'pnpm',
    ['exec', 'playwright', 'test', '-c', 'tests/e2e/playwright.config.ts', '--reporter=list,json'],
    {
      E2E_BASE_URL: STUDIO_ORIGIN,
      E2E_OPERATOR_PASSWORD: operatorPassword,
      E2E_API_PLATFORM: process.platform,
      E2E_FIXTURE_REPO_BASE: fixtureBase,
      PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
    },
  );
  if (LINUX) await assertLinuxTestsRan(reportPath);
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
