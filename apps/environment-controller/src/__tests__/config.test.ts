import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, SETTING_NAMES } from '../config.js';

const TOKEN = 'a-test-token-of-at-least-32-characters-0123456789';

const dockerEnv = {
  STUDIO_API_URL: 'http://127.0.0.1:3001/',
  STUDIO_CONTROLLER_TOKEN: TOKEN,
  STUDIO_CONTROLLER_DATA_DIR: '/home/preview/data/',
  HOME: '/home/preview',
  XDG_RUNTIME_DIR: '/run/user/2002',
  DOCKER_HOST: 'unix:///run/user/2002/docker.sock',
};

const fakeEnv = {
  STUDIO_API_URL: 'http://127.0.0.1:3001',
  STUDIO_CONTROLLER_TOKEN: TOKEN,
  STUDIO_CONTROLLER_DATA_DIR: '/tmp/controller',
  STUDIO_CONTROLLER_ENVIRONMENT: 'test',
  STUDIO_CONTROLLER_RUNTIME: 'fake',
};

const problemsOf = (env: Record<string, string | undefined>): string => {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  throw new Error('expected the settings to be refused');
};

describe('loadConfig', () => {
  it('reads the settings with their defaults', () => {
    expect(loadConfig(dockerEnv)).toMatchObject({
      apiUrl: 'http://127.0.0.1:3001',
      environment: 'production',
      runtime: 'docker',
      dataDir: '/home/preview/data',
      pollMs: 5000,
      heartbeatMs: 15_000,
      minFreeBytes: 2 * 1024 ** 3,
      buildCacheMaxBytes: 10 * 1024 ** 3,
      proxyGid: 2003,
      proxyDir: '/run/preview-proxy',
      rootless: true,
      docker: { home: '/home/preview', xdgRuntimeDir: '/run/user/2002' },
    });
  });

  it('accepts the fake runtime in test and development, without Docker settings', () => {
    expect(loadConfig(fakeEnv)).toMatchObject({ runtime: 'fake', docker: null });
    expect(loadConfig({ ...fakeEnv, STUDIO_CONTROLLER_ENVIRONMENT: 'development' }).runtime).toBe(
      'fake',
    );
  });

  it('refuses the fake runtime and a system Docker in production', () => {
    expect(problemsOf({ ...fakeEnv, STUDIO_CONTROLLER_ENVIRONMENT: 'production' })).toContain(
      'fake is allowed only in development or test',
    );
    expect(problemsOf({ ...dockerEnv, STUDIO_CONTROLLER_ROOTLESS: 'false' })).toContain(
      'ROOTLESS=false is allowed only in development or test',
    );
  });

  it('requires DOCKER_HOST to be the rootless socket of XDG_RUNTIME_DIR', () => {
    expect(problemsOf({ ...dockerEnv, DOCKER_HOST: 'unix:///var/run/docker.sock' })).toContain(
      'DOCKER_HOST must be unix://$XDG_RUNTIME_DIR/docker.sock',
    );
    expect(problemsOf({ ...dockerEnv, DOCKER_HOST: undefined })).toContain('DOCKER_HOST');
    expect(problemsOf({ ...dockerEnv, HOME: undefined })).toContain('HOME is required');
    expect(problemsOf({ ...dockerEnv, XDG_RUNTIME_DIR: undefined })).toContain(
      'XDG_RUNTIME_DIR is required',
    );
  });

  it('refuses a missing or short token without echoing it', () => {
    expect(problemsOf({ ...fakeEnv, STUDIO_CONTROLLER_TOKEN: undefined })).toContain(
      'STUDIO_CONTROLLER_TOKEN',
    );
    const message = problemsOf({ ...fakeEnv, STUDIO_CONTROLLER_TOKEN: 'short-secret-value' });
    expect(message).toContain('at least 32');
    expect(message).not.toContain('short-secret-value');
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'STUDIO_SECRETS_KEY',
    'STUDIO_OPERATOR_PASSWORD_HASH',
    'STUDIO_MERGE_TOKEN',
    'POSTGRES_PASSWORD',
    'STUDIO_WORKER_TOKEN',
    'STUDIO_AGENT_GITHUB_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
  ])('refuses to start when %s is present, without echoing its value', (name) => {
    const message = problemsOf({ ...fakeEnv, [name]: 'value-that-must-not-leak' });
    expect(message).toContain(name);
    expect(message).not.toContain('value-that-must-not-leak');
  });

  it('refuses another egress rules script in production, and accepts it in test', () => {
    expect(
      problemsOf({ ...dockerEnv, STUDIO_CONTROLLER_EGRESS_RULES_BIN: '/tmp/always-ok' }),
    ).toContain('EGRESS_RULES_BIN may be changed only in development or test');
    expect(
      loadConfig({
        ...fakeEnv,
        STUDIO_CONTROLLER_EGRESS_RULES_BIN: '/tmp/always-ok',
      }).egressRulesBin,
    ).toBe('/tmp/always-ok');
  });

  it('refuses relative paths and out-of-range numbers', () => {
    expect(problemsOf({ ...fakeEnv, STUDIO_CONTROLLER_DATA_DIR: 'relative/dir' })).toContain(
      'absolute',
    );
    expect(problemsOf({ ...fakeEnv, STUDIO_CONTROLLER_DATA_DIR: '/' })).toContain('root');
    expect(problemsOf({ ...fakeEnv, STUDIO_CONTROLLER_POLL_MS: '5' })).toContain('POLL_MS');
    expect(problemsOf({ ...fakeEnv, STUDIO_CONTROLLER_BUILD_CACHE_MAX_GB: '0' })).toContain(
      'BUILD_CACHE_MAX_GB',
    );
    expect(problemsOf({ ...fakeEnv, STUDIO_CONTROLLER_PROXY_GID: '0' })).toContain('PROXY_GID');
  });
});

describe('.env.example', () => {
  const example = readFileSync(join(import.meta.dirname, '..', '..', '.env.example'), 'utf8');

  it('lists every setting, and the secret ones empty', () => {
    for (const name of SETTING_NAMES) {
      expect(example, name).toMatch(new RegExp(`^(# )?${name}=`, 'm'));
    }
    expect(example).toMatch(/^STUDIO_CONTROLLER_TOKEN=$/m);
  });

  it('parses as settings once the token and the Docker variables are filled in', () => {
    const values = Object.fromEntries(
      example
        .split('\n')
        .map((line) => /^(?:# )?([A-Z_]+)=(.*)$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => [match[1]!, match[2]!]),
    );
    expect(loadConfig({ ...values, STUDIO_CONTROLLER_TOKEN: TOKEN })).toMatchObject({
      runtime: 'docker',
      rootless: true,
    });
  });
});
