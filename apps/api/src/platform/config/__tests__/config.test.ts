import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigValidationError, findWorkspaceRoot, loadConfig } from '../config.js';

// The data directory must exist, be writable and lie outside the repository checkout.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'studio-config-test-'));
afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }));

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
  STUDIO_DATA_DIR: DATA_DIR,
};

const requiredEnv = {
  DATABASE_URL: validEnv.DATABASE_URL,
  REDIS_URL: validEnv.REDIS_URL,
  STUDIO_OPERATOR_PASSWORD_HASH: validEnv.STUDIO_OPERATOR_PASSWORD_HASH,
  STUDIO_SECRETS_KEY: validEnv.STUDIO_SECRETS_KEY,
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
      dataDir: DATA_DIR,
      gitAllowFileRemotes: false,
      gitAllowPrivateRemotes: false,
      sshKnownHosts: [],
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

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'STUDIO_OPERATOR_PASSWORD_HASH',
    'STUDIO_SECRETS_KEY',
    'STUDIO_DATA_DIR',
  ])('fails fast when %s is missing', (name) => {
    const env: Record<string, string> = { ...requiredEnv };
    delete env[name];
    const error = captureError(() => loadConfig(env));
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error.message).toMatch(new RegExp(name));
  });

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

    it.runIf(process.platform !== 'win32')(
      'fails fast when it holds characters the SSH command line cannot carry',
      () => {
        const spaced = join(DATA_DIR, 'Studio Data');
        mkdirSync(spaced);
        const error = captureError(() => loadConfig({ ...requiredEnv, STUDIO_DATA_DIR: spaced }));
        expect(error.message).toMatch(
          /STUDIO_DATA_DIR: may contain only letters, digits and "\._\/-"/,
        );
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

  describe('STUDIO_GIT_ALLOW_PRIVATE_REMOTES (Issue #69)', () => {
    it.each([['production'], ['development'], ['test'], [undefined]])(
      'is closed by default (NODE_ENV=%s): no loopback or private remotes',
      (nodeEnv) => {
        expect(loadConfig({ ...requiredEnv, NODE_ENV: nodeEnv }).gitAllowPrivateRemotes).toBe(
          false,
        );
      },
    );

    it.each([['production'], ['test']])('opens with true, also with NODE_ENV=%s', (nodeEnv) => {
      expect(
        loadConfig({ ...requiredEnv, NODE_ENV: nodeEnv, STUDIO_GIT_ALLOW_PRIVATE_REMOTES: 'true' })
          .gitAllowPrivateRemotes,
      ).toBe(true);
      expect(
        loadConfig({ ...requiredEnv, STUDIO_GIT_ALLOW_PRIVATE_REMOTES: 'false' })
          .gitAllowPrivateRemotes,
      ).toBe(false);
    });

    it.each([['yes'], ['1'], ['TRUE'], ['']])('rejects %j: only true or false', (value) => {
      const error = captureError(() =>
        loadConfig({ ...requiredEnv, STUDIO_GIT_ALLOW_PRIVATE_REMOTES: value }),
      );
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.message).toMatch(/STUDIO_GIT_ALLOW_PRIVATE_REMOTES/);
    });
  });

  describe('STUDIO_SSH_KNOWN_HOSTS (Issue #62)', () => {
    /** A throwaway ed25519 public key as `ssh-ed25519 <base64>`, generated per run. */
    function hostKey(): string {
      const der = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
      const sshString = (bytes: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        return Buffer.concat([length, bytes]);
      };
      const blob = Buffer.concat([
        sshString(Buffer.from('ssh-ed25519')),
        sshString(der.subarray(der.length - 32)),
      ]);
      return `ssh-ed25519 ${blob.toString('base64')}`;
    }
    const keyA = hostKey();
    const keyB = hostKey();
    const load = (value: string) =>
      loadConfig({ ...requiredEnv, STUDIO_SSH_KNOWN_HOSTS: value }).sshKnownHosts;

    it('is optional and may be empty', () => {
      expect(loadConfig(requiredEnv).sshKnownHosts).toEqual([]);
      expect(load('')).toEqual([]);
      expect(load('  \n ')).toEqual([]);
    });

    it('reads one known_hosts line per line (a double-quoted multi-line .env value)', () => {
      expect(
        load(`github.com ${keyA}\n[git.example.com]:2222,Git.Example.org ${keyB} comment\n`),
      ).toEqual([
        { hosts: ['github.com'], key: keyA },
        { hosts: ['[git.example.com]:2222', 'git.example.org'], key: keyB },
      ]);
    });

    it('also reads lines separated by a literal \n (an env var set on one line)', () => {
      expect(load(`github.com ${keyA}\ngitlab.com ${keyB}`)).toEqual([
        { hosts: ['github.com'], key: keyA },
        { hosts: ['gitlab.com'], key: keyB },
      ]);
    });

    it('ignores blank lines and comments, and reads CRLF', () => {
      expect(load(`# GitHub\r\n\r\n  github.com ${keyA}  \r\n# end`)).toEqual([
        { hosts: ['github.com'], key: keyA },
      ]);
    });

    it('writes port 22 as the plain host name', () => {
      expect(load(`[github.com]:22 ${keyA}`)).toEqual([{ hosts: ['github.com'], key: keyA }]);
    });

    it.each([
      ['too few fields', 'github.com'],
      ['a hashed host name', `|1|c2FsdA==|aGFzaA== ${keyA}`],
      ['a marker', `@cert-authority github.com ${keyA}`],
      ['a wildcard', `*.github.com ${keyA}`],
      ['a negated host', `!github.com ${keyA}`],
      ['an invalid host', `exa_mple.com ${keyA}`],
      ['an invalid port', `[github.com]:70000 ${keyA}`],
      ['an unknown key type', `github.com ssh-dss ${keyA.split(' ')[1]}`],
      ['broken base64', 'github.com ssh-ed25519 @@@@'],
      ['a type that does not match the key', `github.com ssh-rsa ${keyA.split(' ')[1]}`],
    ])('refuses to start on %s, naming the line but not its value', (_case, line) => {
      const error = captureError(() => load(`# comment\ngithub.com ${keyB}\n${line}`));
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.message).toMatch(/STUDIO_SSH_KNOWN_HOSTS: line 3: /);
      expect(error.message).not.toContain(line);
      expect(error.message).not.toContain(keyA.split(' ')[1]);
    });
  });
});
