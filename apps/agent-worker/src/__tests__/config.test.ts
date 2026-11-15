import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertSupportedPlatform,
  loadWorkerConfig,
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
    });
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

describe('assertSupportedPlatform', () => {
  it('accepts Linux', () => {
    expect(() => assertSupportedPlatform('linux')).not.toThrow();
  });

  it.each([['win32'], ['darwin']] as const)('refuses %s with a clear message', (platform) => {
    expect(() => assertSupportedPlatform(platform)).toThrow(UnsupportedPlatformError);
    expect(() => assertSupportedPlatform(platform)).toThrow(/runs on Linux only/);
  });
});
