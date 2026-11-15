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
const env = { STUDIO_API_URL: 'http://127.0.0.1:3001/', STUDIO_WORKER_TOKEN: TOKEN };

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
    });
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
