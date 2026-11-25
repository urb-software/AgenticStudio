import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
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
    const { secretsKey, workerToken, controllerToken, ...config } = loadConfig(validEnv);
    expect(workerToken).toBeNull();
    expect(controllerToken).toBeNull();
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
      workerLeaseSeconds: 60,
      controllerLeaseSeconds: 60,
      previewLimits: { memoryMiB: 1024, cpuPercent: 100, tasksMax: 512, buildMinutes: 20 },
      previewLogMaxBytes: 2 * 1024 * 1024,
      previewUnclaimedMinutes: 5,
      previewMaxRunning: 3,
      runLimits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
      runLogMaxBytes: 8 * 1024 * 1024,
      runSnapshotRetentionDays: 7,
      operatorGithubLogin: null,
      definitionsCommitIdentity: null,
      mergeCredential: null,
      mergeGithubApiUrl: null,
      previewDomain: null,
      retention: {
        days: 7,
        maxPerProject: 10,
        openPullRequestIdleDays: 30,
        hoursAfterPullRequestEnd: 24,
      },
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

  describe('STUDIO_GIT_ALLOW_PRIVATE_REMOTES', () => {
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

  describe('STUDIO_SSH_KNOWN_HOSTS', () => {
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

  describe('agent worker settings', () => {
    // A throwaway token generated per run: no token is committed.
    const TOKEN = randomBytes(32).toString('base64');

    it('has no worker token when STUDIO_WORKER_TOKEN is unset or empty (worker routes then reject all)', () => {
      expect(loadConfig(requiredEnv).workerToken).toBeNull();
      expect(loadConfig({ ...requiredEnv, STUDIO_WORKER_TOKEN: '' }).workerToken).toBeNull();
    });

    it('keeps only the SHA-256 digest of the token, as a key object that never prints', () => {
      const { workerToken } = loadConfig({ ...requiredEnv, STUDIO_WORKER_TOKEN: TOKEN });
      expect(workerToken?.type).toBe('secret');
      expect(workerToken?.export().equals(createHash('sha256').update(TOKEN).digest())).toBe(true);
      expect(inspect(workerToken)).not.toContain(TOKEN);
      expect(JSON.stringify(workerToken)).not.toContain(TOKEN);
    });

    it('refuses a token shorter than 32 characters without echoing it', () => {
      const short = 'x'.repeat(31);
      const error = captureError(() => loadConfig({ ...requiredEnv, STUDIO_WORKER_TOKEN: short }));
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.message).toMatch(/STUDIO_WORKER_TOKEN: must be at least 32 characters/);
      expect(error.message).not.toContain(short);
    });

    it('accepts exactly 32 characters', () => {
      expect(
        loadConfig({ ...requiredEnv, STUDIO_WORKER_TOKEN: 'y'.repeat(32) }).workerToken,
      ).not.toBeNull();
    });

    it('leases a claimed Run for 60 seconds by default', () => {
      expect(loadConfig(requiredEnv).workerLeaseSeconds).toBe(60);
      expect(
        loadConfig({ ...requiredEnv, STUDIO_WORKER_LEASE_SECONDS: '120' }).workerLeaseSeconds,
      ).toBe(120);
    });

    it.each([['0'], ['9'], ['3601'], ['1.5'], ['abc']])(
      'refuses a lease of %j (whole seconds, 10-3600)',
      (value) => {
        const error = captureError(() =>
          loadConfig({ ...requiredEnv, STUDIO_WORKER_LEASE_SECONDS: value }),
        );
        expect(error.message).toMatch(/STUDIO_WORKER_LEASE_SECONDS/);
      },
    );
  });

  describe('environment controller settings', () => {
    // Throwaway tokens generated per run: no token is committed.
    const TOKEN = randomBytes(32).toString('base64');

    it('has no controller token when STUDIO_CONTROLLER_TOKEN is unset or empty (controller routes then reject all)', () => {
      expect(loadConfig(requiredEnv).controllerToken).toBeNull();
      expect(
        loadConfig({ ...requiredEnv, STUDIO_CONTROLLER_TOKEN: '' }).controllerToken,
      ).toBeNull();
    });

    it('keeps only the SHA-256 digest of the token, as a key object that never prints', () => {
      const { controllerToken } = loadConfig({ ...requiredEnv, STUDIO_CONTROLLER_TOKEN: TOKEN });
      expect(controllerToken?.type).toBe('secret');
      expect(controllerToken?.export().equals(createHash('sha256').update(TOKEN).digest())).toBe(
        true,
      );
      expect(inspect(controllerToken)).not.toContain(TOKEN);
    });

    it('refuses a token shorter than 32 characters without echoing it', () => {
      const short = 'x'.repeat(31);
      const error = captureError(() =>
        loadConfig({ ...requiredEnv, STUDIO_CONTROLLER_TOKEN: short }),
      );
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.message).toMatch(/STUDIO_CONTROLLER_TOKEN: must be at least 32 characters/);
      expect(error.message).not.toContain(short);
    });

    it('accepts exactly 32 characters', () => {
      expect(
        loadConfig({ ...requiredEnv, STUDIO_CONTROLLER_TOKEN: 'y'.repeat(32) }).controllerToken,
      ).not.toBeNull();
    });

    it('refuses to start when the controller token equals the worker token, echoing neither', () => {
      const error = captureError(() =>
        loadConfig({
          ...requiredEnv,
          STUDIO_WORKER_TOKEN: TOKEN,
          STUDIO_CONTROLLER_TOKEN: TOKEN,
        }),
      );
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.message).toMatch(
        /STUDIO_CONTROLLER_TOKEN: must differ from STUDIO_WORKER_TOKEN/,
      );
      expect(error.message).not.toContain(TOKEN);
    });

    it('accepts two different tokens', () => {
      const config = loadConfig({
        ...requiredEnv,
        STUDIO_WORKER_TOKEN: 'a'.repeat(32),
        STUDIO_CONTROLLER_TOKEN: 'b'.repeat(32),
      });
      expect(config.workerToken).not.toBeNull();
      expect(config.controllerToken).not.toBeNull();
    });

    it('leases a claimed operation for 60 seconds by default', () => {
      expect(loadConfig(requiredEnv).controllerLeaseSeconds).toBe(60);
      expect(
        loadConfig({ ...requiredEnv, STUDIO_CONTROLLER_LEASE_SECONDS: '120' })
          .controllerLeaseSeconds,
      ).toBe(120);
    });

    it.each([['0'], ['9'], ['3601'], ['1.5'], ['abc']])(
      'refuses a lease of %j (whole seconds, 10-3600)',
      (value) => {
        const error = captureError(() =>
          loadConfig({ ...requiredEnv, STUDIO_CONTROLLER_LEASE_SECONDS: value }),
        );
        expect(error.message).toMatch(/STUDIO_CONTROLLER_LEASE_SECONDS/);
      },
    );
  });

  describe('Preview limits', () => {
    it('are set from the environment', () => {
      expect(
        loadConfig({
          ...requiredEnv,
          STUDIO_PREVIEW_MEMORY_MB: '2048',
          STUDIO_PREVIEW_CPU_PERCENT: '200',
          STUDIO_PREVIEW_TASKS_MAX: '1024',
          STUDIO_PREVIEW_BUILD_MINUTES: '30',
          STUDIO_PREVIEW_LOG_MAX_BYTES: String(1024 * 1024),
        }),
      ).toMatchObject({
        previewLimits: { memoryMiB: 2048, cpuPercent: 200, tasksMax: 1024, buildMinutes: 30 },
        previewLogMaxBytes: 1024 * 1024,
      });
    });

    it.each([
      ['STUDIO_PREVIEW_MEMORY_MB', '127'],
      ['STUDIO_PREVIEW_MEMORY_MB', '65537'],
      ['STUDIO_PREVIEW_CPU_PERCENT', '9'],
      ['STUDIO_PREVIEW_CPU_PERCENT', '6401'],
      ['STUDIO_PREVIEW_TASKS_MAX', '63'],
      ['STUDIO_PREVIEW_TASKS_MAX', '32769'],
      ['STUDIO_PREVIEW_BUILD_MINUTES', '0'],
      ['STUDIO_PREVIEW_BUILD_MINUTES', '121'],
      ['STUDIO_PREVIEW_LOG_MAX_BYTES', '1024'],
      ['STUDIO_PREVIEW_MEMORY_MB', '1.5'],
    ])('refuse %s=%s', (name, value) => {
      const error = captureError(() => loadConfig({ ...requiredEnv, [name]: value }));
      expect(error.message).toContain(name);
    });
  });

  describe('Preview unclaimed minutes', () => {
    it('defaults to 5 and is set from the environment', () => {
      expect(loadConfig(requiredEnv).previewUnclaimedMinutes).toBe(5);
      expect(
        loadConfig({ ...requiredEnv, STUDIO_PREVIEW_UNCLAIMED_MINUTES: '30' })
          .previewUnclaimedMinutes,
      ).toBe(30);
    });

    it.each(['0', '1441', '1.5', 'abc'])('refuses %j (whole minutes, 1-1440)', (value) => {
      const error = captureError(() =>
        loadConfig({ ...requiredEnv, STUDIO_PREVIEW_UNCLAIMED_MINUTES: value }),
      );
      expect(error.message).toContain('STUDIO_PREVIEW_UNCLAIMED_MINUTES');
    });
  });

  describe('Preview running limit', () => {
    it('defaults to 3 and is set from the environment', () => {
      expect(loadConfig(requiredEnv).previewMaxRunning).toBe(3);
      expect(
        loadConfig({ ...requiredEnv, STUDIO_PREVIEW_MAX_RUNNING: '1' }).previewMaxRunning,
      ).toBe(1);
      expect(
        loadConfig({ ...requiredEnv, STUDIO_PREVIEW_MAX_RUNNING: '50' }).previewMaxRunning,
      ).toBe(50);
    });

    it.each(['0', '51', '1.5', 'abc'])('refuses %j (whole places, 1-50)', (value) => {
      const error = captureError(() =>
        loadConfig({ ...requiredEnv, STUDIO_PREVIEW_MAX_RUNNING: value }),
      );
      expect(error.message).toContain('STUDIO_PREVIEW_MAX_RUNNING');
    });
  });

  // The Run limits are configuration, with documented defaults.
  describe('Run limits', () => {
    it('defaults to 60-minute Run steps, 10 Run steps, 14 days of waiting and 50 Run steps in total', () => {
      expect(loadConfig(requiredEnv).runLimits).toEqual({
        stepMinutes: 60,
        maxSteps: 10,
        waitingDays: 14,
        maxTotalSteps: 50,
      });
    });

    it('takes each limit from its variable', () => {
      expect(
        loadConfig({
          ...requiredEnv,
          STUDIO_RUN_STEP_MINUTES: '5',
          STUDIO_RUN_MAX_STEPS: '3',
          STUDIO_RUN_WAITING_DAYS: '2',
          STUDIO_RUN_MAX_TOTAL_STEPS: '7',
        }).runLimits,
      ).toEqual({ stepMinutes: 5, maxSteps: 3, waitingDays: 2, maxTotalSteps: 7 });
    });

    it.each([
      ['STUDIO_RUN_STEP_MINUTES', '0'],
      ['STUDIO_RUN_STEP_MINUTES', '1441'],
      ['STUDIO_RUN_STEP_MINUTES', '1.5'],
      ['STUDIO_RUN_MAX_STEPS', '0'],
      ['STUDIO_RUN_MAX_STEPS', '101'],
      ['STUDIO_RUN_WAITING_DAYS', '0'],
      ['STUDIO_RUN_WAITING_DAYS', '366'],
      ['STUDIO_RUN_WAITING_DAYS', 'abc'],
      ['STUDIO_RUN_MAX_TOTAL_STEPS', '0'],
      ['STUDIO_RUN_MAX_TOTAL_STEPS', '10001'],
    ])('refuses %s=%j', (name, value) => {
      const error = captureError(() => loadConfig({ ...requiredEnv, [name]: value }));
      expect(error.message).toMatch(new RegExp(name));
    });
  });

  describe('STUDIO_RUN_LOG_MAX_BYTES', () => {
    it('caps a Run log at 8 MiB by default', () => {
      expect(loadConfig(requiredEnv).runLogMaxBytes).toBe(8 * 1024 * 1024);
      expect(
        loadConfig({ ...requiredEnv, STUDIO_RUN_LOG_MAX_BYTES: '1048576' }).runLogMaxBytes,
      ).toBe(1_048_576);
    });

    it.each([['65535'], ['1073741825'], ['1.5'], ['abc']])(
      'refuses a cap of %j (whole bytes, 64 KiB-1 GiB)',
      (value) => {
        const error = captureError(() =>
          loadConfig({ ...requiredEnv, STUDIO_RUN_LOG_MAX_BYTES: value }),
        );
        expect(error.message).toMatch(/STUDIO_RUN_LOG_MAX_BYTES/);
      },
    );
  });

  describe('STUDIO_RUN_SNAPSHOT_RETENTION_DAYS', () => {
    it('keeps a retryable Run snapshot 7 days by default', () => {
      expect(loadConfig(requiredEnv).runSnapshotRetentionDays).toBe(7);
      expect(
        loadConfig({ ...requiredEnv, STUDIO_RUN_SNAPSHOT_RETENTION_DAYS: '30' })
          .runSnapshotRetentionDays,
      ).toBe(30);
    });

    it.each([['0'], ['91'], ['1.5'], ['abc']])('refuses %j (whole days, 1-90)', (value) => {
      const error = captureError(() =>
        loadConfig({ ...requiredEnv, STUDIO_RUN_SNAPSHOT_RETENTION_DAYS: value }),
      );
      expect(error.message).toMatch(/STUDIO_RUN_SNAPSHOT_RETENTION_DAYS/);
    });
  });

  describe('the commit identity of the definitions Repository', () => {
    const identity = {
      STUDIO_DEFINITIONS_COMMIT_NAME: 'Studio Publisher',
      STUDIO_DEFINITIONS_COMMIT_EMAIL: 'studio@example.test',
    };

    it('is unset by default, and empty values count as unset', () => {
      expect(loadConfig(requiredEnv).definitionsCommitIdentity).toBeNull();
      expect(
        loadConfig({
          ...requiredEnv,
          STUDIO_DEFINITIONS_COMMIT_NAME: ' ',
          STUDIO_DEFINITIONS_COMMIT_EMAIL: '',
        }).definitionsCommitIdentity,
      ).toBeNull();
    });

    it('reads a name and an email, trimmed', () => {
      expect(
        loadConfig({
          ...requiredEnv,
          STUDIO_DEFINITIONS_COMMIT_NAME: '  Studio Publisher ',
          STUDIO_DEFINITIONS_COMMIT_EMAIL: ' studio@example.test ',
        }).definitionsCommitIdentity,
      ).toEqual({ name: 'Studio Publisher', email: 'studio@example.test' });
    });

    it('refuses one of the two without the other, naming the missing one', () => {
      const noEmail = captureError(() =>
        loadConfig({ ...requiredEnv, STUDIO_DEFINITIONS_COMMIT_NAME: 'Studio Publisher' }),
      );
      expect(noEmail.message).toContain('STUDIO_DEFINITIONS_COMMIT_EMAIL');
      const noName = captureError(() =>
        loadConfig({ ...requiredEnv, STUDIO_DEFINITIONS_COMMIT_EMAIL: 'studio@example.test' }),
      );
      expect(noName.message).toContain('STUDIO_DEFINITIONS_COMMIT_NAME');
    });

    it.each([
      'a<b',
      'a>b',
      'two' + String.fromCharCode(10) + 'lines',
      'a'.repeat(101),
      'bell' + String.fromCharCode(7),
    ])('refuses the name %j', (value) => {
      const error = captureError(() =>
        loadConfig({ ...requiredEnv, ...identity, STUDIO_DEFINITIONS_COMMIT_NAME: value }),
      );
      expect(error.message).toContain('STUDIO_DEFINITIONS_COMMIT_NAME');
      expect(error.message).not.toContain(value);
    });

    it.each([
      'no-at-sign',
      'a b@example.test',
      'a<b@example.test',
      '@example.test',
      'a@',
      `${'a'.repeat(250)}@x.test`,
    ])('refuses the email %j', (value) => {
      const error = captureError(() =>
        loadConfig({ ...requiredEnv, ...identity, STUDIO_DEFINITIONS_COMMIT_EMAIL: value }),
      );
      expect(error.message).toContain('STUDIO_DEFINITIONS_COMMIT_EMAIL');
      expect(error.message).not.toContain(value);
    });
  });

  describe('the operator GitHub login', () => {
    it('is unset by default, and empty counts as unset', () => {
      expect(loadConfig(requiredEnv).operatorGithubLogin).toBeNull();
      expect(
        loadConfig({ ...requiredEnv, STUDIO_OPERATOR_GITHUB_LOGIN: '  ' }).operatorGithubLogin,
      ).toBeNull();
    });

    it('reads a login, trimmed', () => {
      expect(
        loadConfig({ ...requiredEnv, STUDIO_OPERATOR_GITHUB_LOGIN: ' Octo-Cat ' })
          .operatorGithubLogin,
      ).toBe('Octo-Cat');
    });

    it.each(['-octo', 'octo cat', 'octo/cat', 'a'.repeat(40), 'octo[bot]'])(
      'refuses %j',
      (value) => {
        const error = captureError(() =>
          loadConfig({ ...requiredEnv, STUDIO_OPERATOR_GITHUB_LOGIN: value }),
        );
        expect(error.message).toContain('STUDIO_OPERATOR_GITHUB_LOGIN');
      },
    );
  });

  describe('Working copy retention', () => {
    it('defaults to 7 days, 10 per Project, 30 idle days and 24 hours after a pull request ends', () => {
      expect(loadConfig(requiredEnv).retention).toEqual({
        days: 7,
        maxPerProject: 10,
        openPullRequestIdleDays: 30,
        hoursAfterPullRequestEnd: 24,
      });
    });

    it('reads every period and limit from its setting', () => {
      expect(
        loadConfig({
          ...requiredEnv,
          STUDIO_RETENTION_DAYS: '3',
          STUDIO_RETENTION_MAX_PER_PROJECT: '25',
          STUDIO_RETENTION_OPEN_PR_IDLE_DAYS: '14',
          STUDIO_RETENTION_AFTER_PR_END_HOURS: '48',
        }).retention,
      ).toEqual({
        days: 3,
        maxPerProject: 25,
        openPullRequestIdleDays: 14,
        hoursAfterPullRequestEnd: 48,
      });
    });

    it.each([
      ['STUDIO_RETENTION_DAYS', '-1'],
      ['STUDIO_RETENTION_MAX_PER_PROJECT', 'many'],
      ['STUDIO_RETENTION_OPEN_PR_IDLE_DAYS', '0'],
      ['STUDIO_RETENTION_AFTER_PR_END_HOURS', '1.5'],
    ])('refuses %s=%j', (name, value) => {
      const error = captureError(() => loadConfig({ ...requiredEnv, [name]: value }));
      expect(error.message).toContain(name);
    });
  });

  describe('Merge credential', () => {
    // A throwaway value generated per run: no token is committed.
    const MERGE_TOKEN = `fake-${randomBytes(18).toString('hex')}`;

    it.each([undefined, ''])('turns merging off when STUDIO_MERGE_TOKEN is %j', (value) => {
      const env = value === undefined ? requiredEnv : { ...requiredEnv, STUDIO_MERGE_TOKEN: value };
      expect(loadConfig(env).mergeCredential).toBeNull();
    });

    it('keeps a well-formed token revealable but never printed', () => {
      const { mergeCredential } = loadConfig({ ...requiredEnv, STUDIO_MERGE_TOKEN: MERGE_TOKEN });
      expect(mergeCredential?.reveal()).toBe(MERGE_TOKEN);
      expect(inspect(mergeCredential)).not.toContain(MERGE_TOKEN);
      expect(JSON.stringify(mergeCredential)).not.toContain(MERGE_TOKEN);
      expect(`${mergeCredential}`).not.toContain(MERGE_TOKEN);
    });

    it('keeps the token out of a dump of the whole configuration', () => {
      const config = loadConfig({ ...requiredEnv, STUDIO_MERGE_TOKEN: MERGE_TOKEN });
      expect(inspect(config, { depth: null })).not.toContain(MERGE_TOKEN);
      expect(JSON.stringify(config)).not.toContain(MERGE_TOKEN);
    });

    it('accepts 20 and 255 characters', () => {
      for (const length of [20, 255]) {
        expect(
          loadConfig({ ...requiredEnv, STUDIO_MERGE_TOKEN: 'a'.repeat(length) }).mergeCredential,
        ).not.toBeNull();
      }
    });

    it.each([
      ['too short', 'a'.repeat(19)],
      ['too long', 'a'.repeat(256)],
      ['with a space', `${'a'.repeat(12)} ${'b'.repeat(12)}`],
      [
        'with a line break',
        `${'a'.repeat(12)}
${'b'.repeat(12)}`,
      ],
      ['with a tab', `${'a'.repeat(12)}	${'b'.repeat(12)}`],
    ])('stops start-up for a token %s, naming the setting and not the value', (_name, value) => {
      const error = captureError(() => loadConfig({ ...requiredEnv, STUDIO_MERGE_TOKEN: value }));
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.message).toContain('STUDIO_MERGE_TOKEN');
      expect(error.message).not.toContain(value);
    });

    it('accepts the merge API URL override only with NODE_ENV=test', () => {
      const env = { ...requiredEnv, STUDIO_MERGE_GITHUB_API_URL: 'http://127.0.0.1:9999/' };
      expect(loadConfig({ ...env, NODE_ENV: 'test' }).mergeGithubApiUrl).toBe(
        'http://127.0.0.1:9999',
      );
      const error = captureError(() => loadConfig(env));
      expect(error.message).toMatch(/STUDIO_MERGE_GITHUB_API_URL: is a test-only setting/);
    });
  });

  describe('STUDIO_PREVIEW_DOMAIN with a Studio hostname that ends in a dot', () => {
    const studio = { ...requiredEnv, STUDIO_ORIGIN: 'https://studio.example.' };

    it.each(['studio.example', 'x.studio.example'])('refuses %s', (value) => {
      const error = captureError(() => loadConfig({ ...studio, STUDIO_PREVIEW_DOMAIN: value }));
      expect(error.message).toContain('STUDIO_PREVIEW_DOMAIN');
      expect(error.message).toContain('own hostname');
    });
  });

  describe('STUDIO_PREVIEW_DOMAIN', () => {
    const studio = { ...requiredEnv, STUDIO_ORIGIN: 'https://studio.example.test' };

    it('is null while unset or empty', () => {
      expect(loadConfig(studio).previewDomain).toBeNull();
      expect(loadConfig({ ...studio, STUDIO_PREVIEW_DOMAIN: '  ' }).previewDomain).toBeNull();
    });

    it('accepts a DNS name, lowercased, that is not Studio or below it', () => {
      for (const domain of [
        'preview.example.test',
        'example.test',
        'studio.example.test.invalid',
      ]) {
        expect(loadConfig({ ...studio, STUDIO_PREVIEW_DOMAIN: domain }).previewDomain).toBe(domain);
      }
      expect(
        loadConfig({ ...studio, STUDIO_PREVIEW_DOMAIN: ' Preview.Example.TEST ' }).previewDomain,
      ).toBe('preview.example.test');
    });

    it.each([
      ['an IP address', '203.0.113.7'],
      ['one label', 'onelabel'],
      ['an empty label', 'preview..example.test'],
      ['a leading hyphen', '-preview.example.test'],
      ['a scheme', 'https://preview.example.test'],
      ['a path', 'preview.example.test/x'],
      ['a port', 'preview.example.test:8443'],
      ['a label over 63 characters', `${'a'.repeat(64)}.example.test`],
      ['a name over 253 characters', `${'a'.repeat(60)}.`.repeat(5) + 'example.test'],
    ])('stops start-up for %s, naming the setting and not the value', (_name, value) => {
      const error = captureError(() => loadConfig({ ...studio, STUDIO_PREVIEW_DOMAIN: value }));
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect(error.message).toContain('STUDIO_PREVIEW_DOMAIN');
      expect(error.message).not.toContain(value);
    });

    it.each(['studio.example.test', 'preview.studio.example.test', 'STUDIO.example.test'])(
      "stops start-up for Studio's own hostname or a name under it (%s)",
      (value) => {
        const error = captureError(() => loadConfig({ ...studio, STUDIO_PREVIEW_DOMAIN: value }));
        expect(error.message).toContain('STUDIO_PREVIEW_DOMAIN');
        expect(error.message).toContain('own hostname');
        expect(error.message).not.toContain(value);
      },
    );
  });
});
