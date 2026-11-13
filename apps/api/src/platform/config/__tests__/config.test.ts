import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigValidationError, findWorkspaceRoot, loadConfig } from '../config.js';

// The data directory must exist, be writable and lie outside the repository checkout.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'studio-config-test-'));
afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }));

// A format-valid Argon2id PHC string with dummy salt and digest: a fixture, not a credential.
const PHC_SALT_AND_DIGEST = 'c29tZXNhbHRzb21lc2FsdA$ZHVtbXlkaWdlc3RkdW1teWRpZ2VzdGR1bW15ZGlnZXN0';
const BASELINE_HASH = `$argon2id$v=19$m=19456,t=2,p=1$${PHC_SALT_AND_DIGEST}`;

const validEnv = {
  DATABASE_URL: 'postgresql://user:placeholder@localhost:5432/studio',
  REDIS_URL: 'redis://localhost:6379',
  STUDIO_OPERATOR_PASSWORD_HASH: BASELINE_HASH,
  API_PORT: '4001',
  API_HOST: '0.0.0.0',
  API_ORIGIN: 'http://localhost:4001',
  API_TRUSTED_PROXIES: '10.0.0.1, 172.16.0.0/12,fd00::/8',
  STUDIO_ORIGIN: 'https://studio.example.test',
  STUDIO_DATA_DIR: DATA_DIR,
};

const requiredEnv = {
  DATABASE_URL: validEnv.DATABASE_URL,
  REDIS_URL: validEnv.REDIS_URL,
  STUDIO_OPERATOR_PASSWORD_HASH: validEnv.STUDIO_OPERATOR_PASSWORD_HASH,
  STUDIO_DATA_DIR: DATA_DIR,
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
    expect(loadConfig(validEnv)).toEqual({
      apiPort: 4001,
      apiHost: '0.0.0.0',
      apiOrigin: 'http://localhost:4001',
      apiTrustedProxies: ['10.0.0.1', '172.16.0.0/12', 'fd00::/8'],
      databaseUrl: 'postgresql://user:placeholder@localhost:5432/studio',
      redisUrl: 'redis://localhost:6379',
      studioOrigin: 'https://studio.example.test',
      operatorPasswordHash: BASELINE_HASH,
      dataDir: DATA_DIR,
      gitAllowFileRemotes: false,
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

  it.each(['DATABASE_URL', 'REDIS_URL', 'STUDIO_OPERATOR_PASSWORD_HASH', 'STUDIO_DATA_DIR'])(
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

  describe('STUDIO_DATA_DIR', () => {
    const workspaceRoot = findWorkspaceRoot(import.meta.dirname)!;

    it('finds the repository checkout from the API source', () => {
      expect(workspaceRoot).toBe(resolve(import.meta.dirname, '../../../../../..'));
    });

    it.each([
      ['empty', ''],
      ['relative', 'data/studio'],
      ['missing', join(DATA_DIR, 'does-not-exist')],
      ['a file, not a directory', join(import.meta.dirname, 'config.test.ts')],
    ])('fails fast when it is %s', (_, value) => {
      const error = captureError(() => loadConfig({ ...requiredEnv, STUDIO_DATA_DIR: value }));
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.message).toMatch(/STUDIO_DATA_DIR/);
    });

    it.each([
      ['the repository checkout', () => workspaceRoot],
      ['inside the repository checkout', () => join(workspaceRoot, 'apps', 'api')],
    ])('fails fast when it is %s', (_, value) => {
      const error = captureError(() =>
        loadConfig({ ...requiredEnv, STUDIO_DATA_DIR: value() }, { workspaceRoot }),
      );
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.message).toMatch(/STUDIO_DATA_DIR: must be outside the repository checkout/);
    });

    it.runIf(process.platform === 'linux' && process.getuid?.() !== 0)(
      'fails fast when it is not writable',
      () => {
        const error = captureError(() => loadConfig({ ...requiredEnv, STUDIO_DATA_DIR: '/proc' }));
        expect(error.message).toMatch(/STUDIO_DATA_DIR: must be writable/);
      },
    );

    it('does not echo the path in the error message', () => {
      const value = join(DATA_DIR, 'secret-looking-name');
      const error = captureError(() => loadConfig({ ...requiredEnv, STUDIO_DATA_DIR: value }));
      expect(error.message).not.toContain('secret-looking-name');
    });
  });

  describe('STUDIO_GIT_ALLOW_FILE_REMOTES (test-only)', () => {
    it('is off by default', () => {
      expect(loadConfig({ ...requiredEnv, NODE_ENV: 'test' }).gitAllowFileRemotes).toBe(false);
    });

    it('is accepted when NODE_ENV=test', () => {
      expect(
        loadConfig({ ...requiredEnv, NODE_ENV: 'test', STUDIO_GIT_ALLOW_FILE_REMOTES: 'true' })
          .gitAllowFileRemotes,
      ).toBe(true);
    });

    it.each([['production'], ['development'], [undefined]])(
      'refuses to start when set with NODE_ENV=%s',
      (nodeEnv) => {
        const error = captureError(() =>
          loadConfig({ ...requiredEnv, NODE_ENV: nodeEnv, STUDIO_GIT_ALLOW_FILE_REMOTES: 'true' }),
        );
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect(error.message).toMatch(
          /STUDIO_GIT_ALLOW_FILE_REMOTES: is a test-only setting; it is accepted only with NODE_ENV=test/,
        );
      },
    );

    it('rejects values other than true or false', () => {
      const error = captureError(() =>
        loadConfig({ ...requiredEnv, NODE_ENV: 'test', STUDIO_GIT_ALLOW_FILE_REMOTES: 'yes' }),
      );
      expect(error.message).toMatch(/STUDIO_GIT_ALLOW_FILE_REMOTES/);
    });
  });
});
