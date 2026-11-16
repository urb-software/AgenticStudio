import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertSupportedPlatform,
  loadWorkerConfig,
  STUDIO_SIDE_VARIABLES,
  UnsupportedPlatformError,
  WorkerConfigError,
} from '../config.js';

// A throwaway token generated per run; no token is committed.
const TOKEN = randomBytes(32).toString('base64');
const env = {
  STUDIO_API_URL: 'http://127.0.0.1:3001/',
  STUDIO_WORKER_TOKEN: TOKEN,
  STUDIO_WORKER_DATA_DIR: '/var/lib/studio-agent/',
  STUDIO_AGENT_GIT_NAME: 'Studio Agent',
  STUDIO_AGENT_GIT_EMAIL: 'agent@example.test',
};

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the function to throw');
}

describe('loadWorkerConfig', () => {
  it('reads the API URL and token, with 5 s polling and 10 s heartbeats by default', () => {
    expect(loadWorkerConfig(env)).toEqual({
      apiUrl: 'http://127.0.0.1:3001',
      token: TOKEN,
      pollMs: 5000,
      heartbeatMs: 10_000,
      requestTimeoutMs: 30_000,
      runner: 'cli',
      environment: 'production',
      providers: { claude_code: false, codex: false },
      providerBinaries: { claude_code: 'claude', codex: 'codex' },
      dataDir: '/var/lib/studio-agent',
      agentGitName: 'Studio Agent',
      agentGitEmail: 'agent@example.test',
      minFreeBytes: 10 * 1024 ** 3,
      killGraceMs: 10_000,
      claudeMaxTurns: 200,
      codexSandbox: 'workspace-write',
      agentGitHub: { apiUrl: 'https://api.github.com' },
      diffLimits: { filePatchBytes: 256 * 1024, patchBytes: 2048 * 1024, files: 1000 },
    });
  });

  it("reads the diff limits (Issue #144), never above the worker protocol's own", () => {
    expect(
      loadWorkerConfig({
        ...env,
        STUDIO_WORKER_DIFF_FILE_MAX_KIB: '64',
        STUDIO_WORKER_DIFF_MAX_KIB: '512',
        STUDIO_WORKER_DIFF_FILES_MAX: '50',
      }).diffLimits,
    ).toEqual({ filePatchBytes: 64 * 1024, patchBytes: 512 * 1024, files: 50 });
    for (const [name, value] of [
      ['STUDIO_WORKER_DIFF_FILE_MAX_KIB', '513'],
      ['STUDIO_WORKER_DIFF_MAX_KIB', '4097'],
      ['STUDIO_WORKER_DIFF_FILES_MAX', '1001'],
      ['STUDIO_WORKER_DIFF_FILES_MAX', '0'],
    ] as const) {
      expect(() => loadWorkerConfig({ ...env, [name]: value })).toThrow(name);
    }
  });

  it("reads the Agent account's GitHub token and API URL from the worker's own env (Issue #102)", () => {
    const agentToken = `ghp_${randomBytes(18).toString('hex')}`;

    const config = loadWorkerConfig({
      ...env,
      STUDIO_AGENT_GITHUB_TOKEN: agentToken,
      STUDIO_AGENT_GITHUB_API_URL: 'https://github.example.test/api/v3/',
    });

    expect(config.agentGitHub).toEqual({
      token: agentToken,
      apiUrl: 'https://github.example.test/api/v3',
    });
    // An empty value in .env means "not configured".
    expect(loadWorkerConfig({ ...env, STUDIO_AGENT_GITHUB_TOKEN: '' }).agentGitHub).toEqual({
      apiUrl: 'https://api.github.com',
    });
  });

  it('refuses an Agent account token that could inject a header, without echoing it', () => {
    const secret = `ghp_${randomBytes(18).toString('hex')}`;

    const error = captureError(() =>
      loadWorkerConfig({
        ...env,
        STUDIO_AGENT_GITHUB_TOKEN: `${secret}

X-Evil: 1`,
      }),
    );

    expect(error).toBeInstanceOf(WorkerConfigError);
    expect(error.message).toContain('STUDIO_AGENT_GITHUB_TOKEN');
    expect(error.message).not.toContain(secret);
  });

  it('accepts a plain-http GitHub API URL (a test stub) only outside production', () => {
    const stub = { ...env, STUDIO_AGENT_GITHUB_API_URL: 'http://127.0.0.1:4010' };

    expect(captureError(() => loadWorkerConfig(stub)).message).toContain(
      'STUDIO_AGENT_GITHUB_API_URL',
    );
    expect(
      loadWorkerConfig({ ...stub, STUDIO_WORKER_ENVIRONMENT: 'test' }).agentGitHub.apiUrl,
    ).toBe('http://127.0.0.1:4010');
  });

  it('reads the provider switches, each on its own (Issue #101)', () => {
    expect(
      loadWorkerConfig({ ...env, CLAUDE_CODE_ENABLED: 'true', CODEX_CLI_ENABLED: 'false' })
        .providers,
    ).toEqual({ claude_code: true, codex: false });
    expect(loadWorkerConfig({ ...env, CODEX_CLI_ENABLED: 'true' }).providers).toEqual({
      claude_code: false,
      codex: true,
    });
  });

  it.each([
    ['development', 'fake'],
    ['test', 'fake'],
    ['development', 'cli'],
    ['test', 'cli'],
    ['production', 'cli'],
  ] as const)('accepts the %s environment with the %s runner', (environment, runner) => {
    expect(
      loadWorkerConfig({
        ...env,
        STUDIO_WORKER_ENVIRONMENT: environment,
        STUDIO_WORKER_RUNNER: runner,
      }),
    ).toMatchObject({ environment, runner });
  });

  it.each([
    ['explicitly', { STUDIO_WORKER_ENVIRONMENT: 'production' }],
    ['by default', {}],
  ])('refuses the fake runner in production, %s (Issue #101)', (_case, values) => {
    const error = captureError(() =>
      loadWorkerConfig({ ...env, ...values, STUDIO_WORKER_RUNNER: 'fake' }),
    );
    expect(error).toBeInstanceOf(WorkerConfigError);
    expect(error.message).toContain(
      'STUDIO_WORKER_RUNNER: fake is allowed only when STUDIO_WORKER_ENVIRONMENT is development or test',
    );
  });

  it('reads the free disk space the worker keeps, in GiB (Issue #143)', () => {
    expect(loadWorkerConfig({ ...env, STUDIO_WORKER_MIN_FREE_GB: '2.5' }).minFreeBytes).toBe(
      2.5 * 1024 ** 3,
    );
    expect(loadWorkerConfig({ ...env, STUDIO_WORKER_MIN_FREE_GB: '0' }).minFreeBytes).toBe(0);
  });

  it('reads the kill grace of a stopped Run step in seconds (Issue #100)', () => {
    expect(loadWorkerConfig({ ...env, STUDIO_WORKER_KILL_GRACE_SECONDS: '3' }).killGraceMs).toBe(
      3000,
    );
  });

  it('reads the bound on Claude Code agent turns, 200 by default (Issue #105)', () => {
    expect(loadWorkerConfig({ ...env, STUDIO_CLAUDE_MAX_TURNS: '30' }).claudeMaxTurns).toBe(30);
    for (const invalid of ['0', '1001', '2.5', 'many']) {
      expect(() => loadWorkerConfig({ ...env, STUDIO_CLAUDE_MAX_TURNS: invalid })).toThrowError(
        /STUDIO_CLAUDE_MAX_TURNS/,
      );
    }
  });

  it('runs Codex in the workspace-write sandbox and refuses any other mode (Issue #106)', () => {
    expect(loadWorkerConfig(env).codexSandbox).toBe('workspace-write');
    expect(loadWorkerConfig({ ...env, STUDIO_CODEX_SANDBOX: 'workspace-write' }).codexSandbox).toBe(
      'workspace-write',
    );
    for (const invalid of ['danger-full-access', 'read-only', 'WORKSPACE-WRITE', '']) {
      expect(() => loadWorkerConfig({ ...env, STUDIO_CODEX_SANDBOX: invalid })).toThrowError(
        /STUDIO_CODEX_SANDBOX/,
      );
    }
  });

  it('reads the intervals', () => {
    expect(
      loadWorkerConfig({
        ...env,
        STUDIO_WORKER_POLL_MS: '250',
        STUDIO_WORKER_HEARTBEAT_MS: '1000',
      }),
    ).toMatchObject({ pollMs: 250, heartbeatMs: 1000 });
  });

  it.each([
    ['no API URL', { STUDIO_WORKER_TOKEN: TOKEN }, /STUDIO_API_URL/],
    ['no token', { STUDIO_API_URL: env.STUDIO_API_URL }, /STUDIO_WORKER_TOKEN/],
    ['a short token', { ...env, STUDIO_WORKER_TOKEN: 'x'.repeat(31) }, /at least 32/],
    ['a bad interval', { ...env, STUDIO_WORKER_POLL_MS: 'soon' }, /STUDIO_WORKER_POLL_MS/],
    [
      'a too short request timeout',
      { ...env, STUDIO_WORKER_REQUEST_TIMEOUT_MS: '10' },
      /STUDIO_WORKER_REQUEST_TIMEOUT_MS/,
    ],
    ['no data directory', { ...env, STUDIO_WORKER_DATA_DIR: undefined }, /STUDIO_WORKER_DATA_DIR/],
    [
      'a relative data directory',
      { ...env, STUDIO_WORKER_DATA_DIR: 'data/worker' },
      /STUDIO_WORKER_DATA_DIR: must be an absolute path/,
    ],
    [
      'the root as data directory',
      { ...env, STUDIO_WORKER_DATA_DIR: '/' },
      /STUDIO_WORKER_DATA_DIR/,
    ],
    ['no agent Git name', { ...env, STUDIO_AGENT_GIT_NAME: undefined }, /STUDIO_AGENT_GIT_NAME/],
    [
      'an agent Git name with a line break',
      { ...env, STUDIO_AGENT_GIT_NAME: 'Agent\nEvil' },
      /STUDIO_AGENT_GIT_NAME/,
    ],
    ['no agent Git email', { ...env, STUDIO_AGENT_GIT_EMAIL: undefined }, /STUDIO_AGENT_GIT_EMAIL/],
    [
      'an invalid agent Git email',
      { ...env, STUDIO_AGENT_GIT_EMAIL: 'agent <x@y>' },
      /STUDIO_AGENT_GIT_EMAIL/,
    ],
    [
      'negative free disk space',
      { ...env, STUDIO_WORKER_MIN_FREE_GB: '-1' },
      /STUDIO_WORKER_MIN_FREE_GB/,
    ],
    [
      'a non-numeric free disk space',
      { ...env, STUDIO_WORKER_MIN_FREE_GB: 'plenty' },
      /STUDIO_WORKER_MIN_FREE_GB/,
    ],
    [
      'a kill grace of zero',
      { ...env, STUDIO_WORKER_KILL_GRACE_SECONDS: '0' },
      /STUDIO_WORKER_KILL_GRACE_SECONDS/,
    ],
    [
      'a kill grace over five minutes',
      { ...env, STUDIO_WORKER_KILL_GRACE_SECONDS: '301' },
      /STUDIO_WORKER_KILL_GRACE_SECONDS/,
    ],
    ['an unknown runner mode', { ...env, STUDIO_WORKER_RUNNER: 'api' }, /STUDIO_WORKER_RUNNER/],
    ['a relative CLI path', { ...env, CLAUDE_CODE_BIN: './claude' }, /CLAUDE_CODE_BIN/],
    ['a CLI with arguments', { ...env, CODEX_CLI_BIN: 'codex --yolo' }, /CODEX_CLI_BIN/],
    ['an empty CLI path', { ...env, CODEX_CLI_BIN: '' }, /CODEX_CLI_BIN/],
    ['a CLI path with shell syntax', { ...env, CLAUDE_CODE_BIN: 'claude;id' }, /CLAUDE_CODE_BIN/],
    [
      'an unknown environment (not silently production or test)',
      { ...env, STUDIO_WORKER_ENVIRONMENT: 'prod', STUDIO_WORKER_RUNNER: 'fake' },
      /STUDIO_WORKER_ENVIRONMENT/,
    ],
    [
      'a runner mode in other casing',
      { ...env, STUDIO_WORKER_RUNNER: 'FAKE', STUDIO_WORKER_ENVIRONMENT: 'test' },
      /STUDIO_WORKER_RUNNER/,
    ],
  ])('refuses to start with %s', (_case, values, message) => {
    const error = captureError(() => loadWorkerConfig(values));
    expect(error).toBeInstanceOf(WorkerConfigError);
    expect(error.message).toMatch(message);
  });

  it('never echoes the token', () => {
    const short = 'secret-ish-value';
    const error = captureError(() => loadWorkerConfig({ ...env, STUDIO_WORKER_TOKEN: short }));
    expect(error.message).not.toContain(short);
  });
});

describe('Studio-side variables (review of #112)', () => {
  it.each(STUDIO_SIDE_VARIABLES.map((name) => [name]))(
    'refuses to start when %s is present, naming it but not its value',
    (name) => {
      const value = `leaked-${randomBytes(8).toString('hex')}`;
      const error = captureError(() => loadWorkerConfig({ ...env, [name]: value }));
      expect(error).toBeInstanceOf(WorkerConfigError);
      expect(error.message).toContain(`${name}: is a Studio-side setting`);
      expect(error.message).not.toContain(value);
    },
  );

  it('refuses even an empty one, and names every one present', () => {
    const error = captureError(() =>
      loadWorkerConfig({ ...env, DATABASE_URL: '', REDIS_URL: 'redis://x' }),
    );
    expect(error.message).toMatch(/DATABASE_URL[\s\S]*REDIS_URL/);
  });

  it('lists exactly the agreed variables', () => {
    expect([...STUDIO_SIDE_VARIABLES]).toEqual([
      'DATABASE_URL',
      'REDIS_URL',
      'STUDIO_SECRETS_KEY',
      'STUDIO_OPERATOR_PASSWORD_HASH',
      'POSTGRES_PASSWORD',
    ]);
  });
});

describe('assertSupportedPlatform', () => {
  it('accepts Linux', () => {
    expect(() => assertSupportedPlatform('linux')).not.toThrow();
  });

  it.each([['win32'], ['darwin']] as const)('refuses %s with a clear message', (platform) => {
    expect(() => assertSupportedPlatform(platform)).toThrow(UnsupportedPlatformError);
    expect(() => assertSupportedPlatform(platform)).toThrow(/runs on Linux only/);
  });
});
