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
      dataDir: '/var/lib/studio-agent',
      agentGitName: 'Studio Agent',
      agentGitEmail: 'agent@example.test',
      retentionDays: 7,
      retentionMaxPerProject: 10,
    });
  });

  it('reads the retention settings (Issue #98)', () => {
    expect(
      loadWorkerConfig({
        ...env,
        STUDIO_WORKER_RETENTION_DAYS: '3',
        STUDIO_WORKER_RETENTION_MAX_PER_PROJECT: '25',
      }),
    ).toMatchObject({ retentionDays: 3, retentionMaxPerProject: 25 });
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
      'negative retention days',
      { ...env, STUDIO_WORKER_RETENTION_DAYS: '-1' },
      /STUDIO_WORKER_RETENTION_DAYS/,
    ],
    [
      'a non-numeric retention count',
      { ...env, STUDIO_WORKER_RETENTION_MAX_PER_PROJECT: 'many' },
      /STUDIO_WORKER_RETENTION_MAX_PER_PROJECT/,
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
