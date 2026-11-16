// Server Compose files (Issue #107): PostgreSQL and Redis publish no host port, the API and web
// ports are bound to 127.0.0.1 only, and the fixed network defaults agree with the setup script,
// the boundary checks and the server .env template.
//
//   node --test "deploy/tests/*.test.mjs"
//
// The rendering tests run `docker compose config` (renders the files, starts nothing). They run
// on Linux only (CI job deploy:server) and skip elsewhere; the defaults test runs everywhere.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const deployDir = new URL('..', import.meta.url);
const read = (name) => readFileSync(new URL(name, deployDir), 'utf8');
const base = new URL('compose.server.yaml', deployDir).pathname;
const app = new URL('compose.server.app.yaml', deployDir).pathname;

const linux = process.platform === 'linux';
const tmp = mkdtempSync(join(tmpdir(), 'compose-server-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A throwaway env file: test-only placeholders, no real value. */
function envFile(values) {
  const file = join(tmp, `env-${Math.random().toString(36).slice(2)}`);
  writeFileSync(
    file,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
  return file;
}

const TEST_ENV = {
  POSTGRES_PASSWORD: 'test-only-not-a-secret',
  REDIS_PASSWORD: 'test-only-redis-placeholder',
  STUDIO_API_IMAGE: 'registry.example.invalid/studio-api:test',
  STUDIO_WEB_IMAGE: 'registry.example.invalid/studio-web:test',
};

/** `docker compose config` as JSON; the env file is also the API's env_file. */
function render(files, values = TEST_ENV) {
  const env = envFile(values);
  const args = ['compose', '--project-directory', tmp, '--env-file', env];
  for (const file of files) args.push('-f', file);
  args.push('config', '--format', 'json');
  const output = execFileSync('docker', args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, STUDIO_ENV_FILE: env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

describe(
  'server Compose files',
  { skip: !linux && 'renders with docker compose: Linux only' },
  () => {
    it('publishes no host port for PostgreSQL and Redis', () => {
      for (const files of [[base], [base, app]]) {
        const { services } = render(files);
        assert.equal(services.postgres.ports, undefined, files.join(' + '));
        assert.equal(services.redis.ports, undefined, files.join(' + '));
      }
    });

    it('puts PostgreSQL and Redis at their fixed addresses on the studio network', () => {
      const { services, networks } = render([base]);
      assert.equal(services.postgres.networks.studio.ipv4_address, '172.31.250.10');
      assert.equal(services.redis.networks.studio.ipv4_address, '172.31.250.11');
      const subnets = Object.values(networks).flatMap((network) =>
        network.ipam.config.map((entry) => entry.subnet),
      );
      assert.deepEqual(subnets, ['172.31.250.0/24']);
    });

    it('publishes only the API and web ports, on 127.0.0.1', () => {
      const { services } = render([base, app]);
      const published = Object.entries(services).flatMap(([name, service]) =>
        (service.ports ?? []).map((port) => ({ name, ...port })),
      );
      assert.deepEqual(
        published.map(({ name, host_ip, published: host, target }) => [
          name,
          host_ip,
          host,
          target,
        ]),
        [
          ['api', '127.0.0.1', '3001', 3001],
          ['web', '127.0.0.1', '3000', 3000],
        ],
      );
    });

    it('follows the configured host ports and never binds another address', () => {
      const { services } = render([base, app], {
        ...TEST_ENV,
        API_PORT: '13001',
        WEB_PORT: '13000',
      });
      assert.equal(services.api.ports[0].published, '13001');
      assert.equal(services.web.ports[0].published, '13000');
      for (const service of Object.values(services)) {
        for (const port of service.ports ?? []) assert.equal(port.host_ip, '127.0.0.1');
      }
    });

    it('gives the web container no Studio secret', () => {
      const { services } = render([base, app], {
        ...TEST_ENV,
        STUDIO_SECRETS_KEY: 'test-only-placeholder',
        DATABASE_URL: 'postgresql://placeholder@postgres:5432/db',
      });
      const web = Object.keys(services.web.environment ?? {});
      assert.deepEqual(web.sort(), ['API_ORIGIN', 'STUDIO_WEB_API_PROXY']);
      // The API reads the root-only env file.
      assert.equal(services.api.environment.STUDIO_SECRETS_KEY, 'test-only-placeholder');
    });

    it('refuses to render without the database or the Redis password', () => {
      assert.throws(() => render([base], { REDIS_PASSWORD: 'x' }), /POSTGRES_PASSWORD/);
      assert.throws(() => render([base], { POSTGRES_PASSWORD: 'x' }), /REDIS_PASSWORD/);
    });

    it('gives Redis its password through the environment, never on its command line', () => {
      const { redis } = render([base]).services;
      assert.equal(redis.environment.REDIS_PASSWORD, TEST_ENV.REDIS_PASSWORD);
      const command = redis.command.join(' ');
      assert.match(command, /requirepass/);
      assert.ok(!command.includes(TEST_ENV.REDIS_PASSWORD), command);
      assert.ok(!redis.healthcheck.test.join(' ').includes(TEST_ENV.REDIS_PASSWORD));
    });
  },
);

describe('fixed network defaults', () => {
  const defaults = {
    STUDIO_NETWORK_SUBNET: '172.31.250.0/24',
    STUDIO_POSTGRES_ADDRESS: '172.31.250.10',
    STUDIO_REDIS_ADDRESS: '172.31.250.11',
  };

  it('agree between the Compose file, both scripts and the server .env template', () => {
    const compose = read('compose.server.yaml');
    const template = read('studio.env.example');
    const setup = read('setup-server.sh');
    const check = read('check-boundary.sh');
    for (const [name, value] of Object.entries(defaults)) {
      assert.ok(compose.includes(`\${${name}:-${value}}`), `compose.server.yaml: ${name}`);
      assert.match(template, new RegExp(`^${name}=${value.replaceAll('.', '\\.')}$`, 'm'), name);
    }
    assert.match(
      setup,
      /^STUDIO_NETWORK_SUBNET="\$\{STUDIO_NETWORK_SUBNET:-172\.31\.250\.0\/24\}"$/m,
    );
    for (const name of ['STUDIO_POSTGRES_ADDRESS', 'STUDIO_REDIS_ADDRESS']) {
      const value = defaults[name].replaceAll('.', '\\.');
      assert.match(check, new RegExp(`^${name}="\\$\\{${name}:-${value}\\}"$`, 'm'), name);
    }
  });
});
