import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from '../config.js';

// A format-valid Argon2id PHC string with dummy salt and digest: a fixture, not a credential.
const PHC_SALT_AND_DIGEST = 'c29tZXNhbHRzb21lc2FsdA$ZHVtbXlkaWdlc3RkdW1teWRpZ2VzdGR1bW15ZGlnZXN0';
const BASELINE_HASH = `$argon2id$v=19$m=19456,t=2,p=1$${PHC_SALT_AND_DIGEST}`;
// A throwaway master key generated per run: no key material is committed.
const SECRETS_KEY_BYTES = randomBytes(32);
const SECRETS_KEY = SECRETS_KEY_BYTES.toString('base64');

const validEnv = {
  DATABASE_URL: 'postgresql://user:placeholder@localhost:5432/studio',
  REDIS_URL: 'redis://localhost:6379',
  STUDIO_OPERATOR_PASSWORD_HASH: BASELINE_HASH,
  STUDIO_SECRETS_KEY: SECRETS_KEY,
  API_PORT: '4001',
  API_HOST: '0.0.0.0',
  API_ORIGIN: 'http://localhost:4001',
  API_TRUSTED_PROXIES: '10.0.0.1, 172.16.0.0/12,fd00::/8',
  STUDIO_ORIGIN: 'https://studio.example.test',
};

const requiredEnv = {
  DATABASE_URL: validEnv.DATABASE_URL,
  REDIS_URL: validEnv.REDIS_URL,
  STUDIO_OPERATOR_PASSWORD_HASH: validEnv.STUDIO_OPERATOR_PASSWORD_HASH,
  STUDIO_SECRETS_KEY: validEnv.STUDIO_SECRETS_KEY,
};

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the function to throw');
}

describe('loadConfig', () => {
  it('returns typed configuration from a valid environment', () => {
    const { secretsKey, ...config } = loadConfig(validEnv);
    expect(secretsKey.type).toBe('secret');
    expect(secretsKey.export().equals(SECRETS_KEY_BYTES)).toBe(true);
    expect(config).toEqual({
      apiPort: 4001,
      apiHost: '0.0.0.0',
      apiOrigin: 'http://localhost:4001',
      apiTrustedProxies: ['10.0.0.1', '172.16.0.0/12', 'fd00::/8'],
      databaseUrl: 'postgresql://user:placeholder@localhost:5432/studio',
      redisUrl: 'redis://localhost:6379',
      studioOrigin: 'https://studio.example.test',
      operatorPasswordHash: BASELINE_HASH,
    });
  });

  it('defaults to a localhost-only bind, local origins and no trusted proxies', () => {
    expect(loadConfig(requiredEnv)).toMatchObject({
      apiPort: 3001,
      apiHost: '127.0.0.1',
      apiOrigin: 'http://localhost:3001',
      apiTrustedProxies: [],
      studioOrigin: 'http://localhost:3000',
    });
  });

  it('ignores the generic PORT variable that next dev also reads', () => {
    expect(loadConfig({ ...requiredEnv, PORT: '3000' }).apiPort).toBe(3001);
  });

  it('normalizes a trailing slash on the Studio origin', () => {
    expect(
      loadConfig({ ...requiredEnv, STUDIO_ORIGIN: 'http://localhost:4300/' }).studioOrigin,
    ).toBe('http://localhost:4300');
  });

  it('accepts stronger Argon2id parameters than the baseline', () => {
    const stronger = `$argon2id$v=19$m=65536,t=3,p=4$${PHC_SALT_AND_DIGEST}`;
    expect(
      loadConfig({ ...requiredEnv, STUDIO_OPERATOR_PASSWORD_HASH: stronger }).operatorPasswordHash,
    ).toBe(stronger);
  });

  it.each(['DATABASE_URL', 'REDIS_URL', 'STUDIO_OPERATOR_PASSWORD_HASH', 'STUDIO_SECRETS_KEY'])(
    'fails fast when %s is missing',
    (name) => {
      const env: Record<string, string> = { ...requiredEnv };
      delete env[name];
      const error = captureError(() => loadConfig(env));
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.message).toMatch(new RegExp(name));
    },
  );

  it.each([
    ['DATABASE_URL', 'not a url'],
    ['DATABASE_URL', 'mysql://user@localhost/studio'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['API_PORT', 'abc'],
    ['API_PORT', '0'],
    ['API_PORT', '70000'],
    ['API_HOST', ''],
    ['API_HOST', 'bad host'],
    ['API_ORIGIN', 'localhost:3001'],
    ['API_ORIGIN', 'ftp://localhost:3001'],
    ['API_TRUSTED_PROXIES', 'proxy.internal'],
    ['API_TRUSTED_PROXIES', '10.0.0.0/33'],
    ['API_TRUSTED_PROXIES', '10.0.0.1,*'],
    ['STUDIO_ORIGIN', 'localhost:3000'],
    ['STUDIO_ORIGIN', 'http://localhost:3000/login'],
    ['STUDIO_ORIGIN', 'http://studio.example.test'],
    ['STUDIO_OPERATOR_PASSWORD_HASH', 'correct horse battery staple'],
    ['STUDIO_OPERATOR_PASSWORD_HASH', `$argon2i$v=19$m=19456,t=2,p=1$${PHC_SALT_AND_DIGEST}`],
    ['STUDIO_OPERATOR_PASSWORD_HASH', `$argon2id$v=19$m=4096,t=2,p=1$${PHC_SALT_AND_DIGEST}`],
    ['STUDIO_OPERATOR_PASSWORD_HASH', `$argon2id$v=19$m=19456,t=1,p=1$${PHC_SALT_AND_DIGEST}`],
    ['STUDIO_OPERATOR_PASSWORD_HASH', `$argon2id$v=19$m=19456,t=2,p=0$${PHC_SALT_AND_DIGEST}`],
    ['STUDIO_SECRETS_KEY', ''],
    ['STUDIO_SECRETS_KEY', 'not base64 at all!'],
    ['STUDIO_SECRETS_KEY', `-_${SECRETS_KEY.slice(2)}`],
    ['STUDIO_SECRETS_KEY', randomBytes(32).toString('hex')],
    ['STUDIO_SECRETS_KEY', randomBytes(16).toString('base64')],
    ['STUDIO_SECRETS_KEY', randomBytes(31).toString('base64')],
    ['STUDIO_SECRETS_KEY', randomBytes(33).toString('base64')],
    ['STUDIO_SECRETS_KEY', randomBytes(32).toString('base64').replace(/=$/, '')],
    ['STUDIO_SECRETS_KEY', ` ${randomBytes(32).toString('base64')}`],
  ])('fails fast when %s is invalid (%s)', (name, value) => {
    const error = captureError(() => loadConfig({ ...validEnv, [name]: value }));
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error.message).toMatch(new RegExp(name));
  });

  it('does not echo variable values in the error message', () => {
    const leakyUrl = 'postgres-ish://user:do-not-leak@localhost/studio';
    const error = captureError(() => loadConfig({ ...validEnv, DATABASE_URL: leakyUrl }));
    expect(error.message).toMatch(/DATABASE_URL/);
    expect(error.message).not.toContain('do-not-leak');
  });

  it('does not echo a rejected password hash or plaintext in the error message', () => {
    const weak = `$argon2id$v=19$m=4096,t=1,p=1$${PHC_SALT_AND_DIGEST}`;
    for (const value of [weak, 'plaintext-do-not-leak']) {
      const error = captureError(() =>
        loadConfig({ ...validEnv, STUDIO_OPERATOR_PASSWORD_HASH: value }),
      );
      expect(error.message).toMatch(/STUDIO_OPERATOR_PASSWORD_HASH/);
      expect(error.message).not.toContain(PHC_SALT_AND_DIGEST.slice(0, 10));
      expect(error.message).not.toContain('plaintext-do-not-leak');
    }
  });

  it('explains how to fix a missing, malformed or wrong-length secrets key', () => {
    const missing: Record<string, string> = { ...requiredEnv };
    delete missing.STUDIO_SECRETS_KEY;
    expect(captureError(() => loadConfig(missing)).message).toMatch(
      /STUDIO_SECRETS_KEY: .*32 random bytes.*base64/,
    );
    expect(
      captureError(() => loadConfig({ ...requiredEnv, STUDIO_SECRETS_KEY: '!!!!' })).message,
    ).toMatch(/STUDIO_SECRETS_KEY: .*base64/);
    expect(
      captureError(() =>
        loadConfig({ ...requiredEnv, STUDIO_SECRETS_KEY: randomBytes(16).toString('base64') }),
      ).message,
    ).toMatch(/STUDIO_SECRETS_KEY: .*32 bytes/);
  });

  it('does not echo a rejected secrets key in the error message', () => {
    for (const value of [
      randomBytes(16).toString('base64'),
      randomBytes(32).toString('hex'),
      `${randomBytes(32).toString('base64')}x`,
    ]) {
      const error = captureError(() => loadConfig({ ...requiredEnv, STUDIO_SECRETS_KEY: value }));
      expect(error.message).toMatch(/STUDIO_SECRETS_KEY/);
      expect(error.message).not.toContain(value.slice(0, 12));
    }
  });

  it('never exposes the secrets key bytes when the configuration is logged or serialized', () => {
    const config = loadConfig(requiredEnv);
    for (const rendered of [
      inspect(config, { depth: 5 }),
      JSON.stringify(config),
      String(config),
    ]) {
      expect(rendered).not.toContain(SECRETS_KEY);
      expect(rendered).not.toContain(SECRETS_KEY_BYTES.toString('hex'));
    }
  });
});
