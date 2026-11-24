// Server Compose files (Issues #107, #132): only the reverse proxy publishes host ports, the API
// trusts X-Forwarded-For from the proxy's fixed address only, migrations run before the API, every
// Studio container runs hardened as uid 10001, and the fixed network defaults agree with the setup
// script, the boundary checks, the Caddyfile and the server .env template.
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
const preview = new URL('compose.server.preview.yaml', deployDir).pathname;

const linux = process.platform === 'linux';
const tmp = mkdtempSync(join(tmpdir(), 'compose-server-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A throwaway env file: test-only placeholders, no real value. */
function envFile(values) {
  const file = join(tmp, `env-${Math.random().toString(36).slice(2)}`);
  writeFileSync(
    file,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value.includes('$') ? `'${value}'` : value}`)
      .join('\n'),
  );
  return file;
}

const TEST_ENV = {
  POSTGRES_PASSWORD: 'test-only-not-a-secret',
  REDIS_PASSWORD: 'test-only-redis-placeholder',
  STUDIO_API_IMAGE: 'registry.example.invalid/studio-api:test',
  STUDIO_WEB_IMAGE: 'registry.example.invalid/studio-web:test',
  STUDIO_DOMAIN: 'studio.example.invalid',
  STUDIO_TLS: 'internal',
  DATABASE_URL: 'postgresql://studio:test-only-not-a-secret@postgres:5432/agentic_studio',
};

/** Previews: test-only placeholders; the hash is not a real bcrypt hash of anything. */
const PREVIEW_ENV = {
  ...TEST_ENV,
  STUDIO_PREVIEW_DOMAIN: 'preview.example.invalid',
  STUDIO_PREVIEW_PASSWORD_HASH: '$2a$14$test-only-placeholder-not-a-real-bcrypt-hash-0000000000000',
};

const STUDIO_SERVICES = ['migrate', 'api', 'web', 'proxy'];

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

    it('publishes only the reverse proxy: ports 80 and 443, IPv4 only', () => {
      const { services } = render([base, app]);
      const published = Object.entries(services).flatMap(([name, service]) =>
        (service.ports ?? []).map((port) => ({ name, ...port })),
      );
      assert.deepEqual(
        published.map(({ name, host_ip, published: host, target, protocol }) => [
          name,
          host_ip,
          host,
          target,
          protocol,
        ]),
        [
          ['proxy', '0.0.0.0', '80', 80, 'tcp'],
          ['proxy', '0.0.0.0', '443', 443, 'tcp'],
        ],
      );
      assert.equal(services.api.ports, undefined);
      assert.equal(services.web.ports, undefined);
    });

    it('trusts X-Forwarded-For from the reverse proxy only, whatever the .env file says', () => {
      const { services } = render([base, app], {
        ...TEST_ENV,
        API_TRUSTED_PROXIES: '172.31.250.1',
        STUDIO_ORIGIN: 'https://other.example.invalid',
      });
      const proxy = services.proxy.networks.studio.ipv4_address;
      assert.equal(proxy, '172.31.250.20');
      assert.equal(services.api.environment.API_TRUSTED_PROXIES, proxy);
      assert.equal(services.api.environment.STUDIO_ORIGIN, 'https://studio.example.invalid');
      assert.equal(services.proxy.environment.STUDIO_DOMAIN, 'studio.example.invalid');
    });

    it('gives the API and web fixed addresses below the dynamic range', () => {
      const { services, networks } = render([base, app]);
      assert.equal(services.api.networks.studio.ipv4_address, '172.31.250.12');
      assert.equal(services.web.networks.studio.ipv4_address, '172.31.250.13');
      const ranges = Object.values(networks).flatMap((network) =>
        network.ipam.config.map((entry) => entry.ip_range),
      );
      assert.deepEqual(ranges, ['172.31.250.128/25']);
    });

    it('applies the migrations once before the API starts, with the database URL only', () => {
      const { services } = render([base, app]);
      const { migrate, api } = services;
      assert.equal(migrate.image, TEST_ENV.STUDIO_API_IMAGE);
      assert.deepEqual(migrate.command, [
        'node',
        'node_modules/prisma/build/index.js',
        'migrate',
        'deploy',
      ]);
      assert.equal(migrate.working_dir, '/app/packages/database');
      assert.equal(migrate.restart, 'no');
      assert.deepEqual(Object.keys(migrate.environment), ['DATABASE_URL']);
      assert.equal(migrate.env_file, undefined);
      assert.equal(api.depends_on.migrate.condition, 'service_completed_successfully');
      assert.equal(migrate.depends_on.postgres.condition, 'service_healthy');
    });

    it('requires the domain and the TLS setting with the images', () => {
      const { STUDIO_DOMAIN, ...withoutDomain } = TEST_ENV;
      const { STUDIO_TLS, ...withoutTls } = TEST_ENV;
      assert.ok(STUDIO_DOMAIN && STUDIO_TLS);
      assert.throws(() => render([base, app], withoutDomain), /STUDIO_DOMAIN/);
      assert.throws(() => render([base, app], withoutTls), /STUDIO_TLS/);
    });

    it('runs every Studio container hardened as a fixed non-root uid, never the agent uid', () => {
      const { services } = render([base, app]);
      for (const name of STUDIO_SERVICES) {
        const service = services[name];
        assert.equal(service.user, '10001:10001', name);
        assert.equal(service.read_only, true, name);
        assert.deepEqual(service.cap_drop, ['ALL'], name);
        assert.deepEqual(service.security_opt, ['no-new-privileges:true'], name);
        assert.equal(service.privileged ?? false, false, name);
      }
      assert.deepEqual(services.proxy.cap_add, ['NET_BIND_SERVICE']);
      for (const name of ['api', 'web', 'migrate']) assert.equal(services[name].cap_add, undefined);
      const setup = read('setup-server.sh');
      assert.match(setup, /^STUDIO_CONTAINER_UID="\$\{STUDIO_CONTAINER_UID:-10001\}"$/m);
      assert.match(setup, /^AGENT_UID="\$\{AGENT_UID:-2001\}"$/m);
    });

    it('pins the reverse proxy image by digest', () => {
      const { services } = render([base, app]);
      assert.match(services.proxy.image, /^caddy:[\d.]+-alpine@sha256:[\da-f]{64}$/);
    });

    it('gives the web container no Studio secret', () => {
      const { services } = render([base, app], {
        ...TEST_ENV,
        STUDIO_SECRETS_KEY: 'test-only-placeholder',
        DATABASE_URL: 'postgresql://placeholder@postgres:5432/db',
      });
      assert.deepEqual(Object.keys(services.web.environment ?? {}), []);
      assert.equal(services.web.env_file, undefined);
      // The proxy gets its two settings only.
      assert.deepEqual(Object.keys(services.proxy.environment).sort(), [
        'STUDIO_DOMAIN',
        'STUDIO_TLS',
      ]);
      assert.equal(services.proxy.env_file, undefined);
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

    describe('with the Preview overlay', () => {
      const files = [base, app, preview];

      it('changes nothing for the proxy without it', () => {
        const { services } = render([base, app], PREVIEW_ENV);
        assert.deepEqual(Object.keys(services.proxy.environment).sort(), [
          'STUDIO_DOMAIN',
          'STUDIO_TLS',
        ]);
        assert.equal(services.proxy.group_add, undefined);
        assert.equal(
          services.proxy.volumes.some((volume) => volume.target === '/run/preview-proxy'),
          false,
        );
      });

      it('gives the proxy exactly four settings, the group and the two read-only mounts', () => {
        const { proxy } = render(files, PREVIEW_ENV).services;
        assert.deepEqual(Object.keys(proxy.environment).sort(), [
          'STUDIO_DOMAIN',
          'STUDIO_PREVIEW_DOMAIN',
          'STUDIO_PREVIEW_PASSWORD_HASH',
          'STUDIO_TLS',
        ]);
        assert.equal(proxy.environment.STUDIO_PREVIEW_DOMAIN, 'preview.example.invalid');
        assert.equal(
          // `docker compose config` writes a literal `$` as `$$`.
          proxy.environment.STUDIO_PREVIEW_PASSWORD_HASH.replaceAll('$$', '$'),
          PREVIEW_ENV.STUDIO_PREVIEW_PASSWORD_HASH,
        );
        assert.deepEqual(proxy.group_add, ['2003']);
        const sockets = proxy.volumes.find((volume) => volume.target === '/run/preview-proxy');
        assert.equal(sockets.type, 'bind');
        assert.equal(sockets.source, '/run/preview-proxy');
        assert.equal(sockets.read_only, true);
        assert.equal(sockets.bind.create_host_path, true);
        const site = proxy.volumes.find(
          (volume) => volume.target === '/etc/caddy/preview-site.caddy',
        );
        assert.equal(site.read_only, true);
        assert.match(site.source, /\/Caddyfile\.preview$/);
      });

      it('takes the group from PREVIEW_PROXY_GID, default 2003', () => {
        const { proxy } = render(files, { ...PREVIEW_ENV, PREVIEW_PROXY_GID: '2999' }).services;
        assert.deepEqual(proxy.group_add, ['2999']);
      });

      it('keeps the proxy hardened and the only service with host ports, mount or group', () => {
        const { services } = render(files, PREVIEW_ENV);
        const { proxy } = services;
        assert.equal(proxy.user, '10001:10001');
        assert.equal(proxy.read_only, true);
        assert.deepEqual(proxy.cap_drop, ['ALL']);
        assert.deepEqual(proxy.cap_add, ['NET_BIND_SERVICE']);
        assert.deepEqual(proxy.security_opt, ['no-new-privileges:true']);
        assert.equal(proxy.privileged ?? false, false);
        for (const name of ['postgres', 'redis', 'migrate', 'api', 'web']) {
          const service = services[name];
          assert.equal(service.ports, undefined, name);
          assert.equal(service.group_add, undefined, name);
          for (const volume of service.volumes ?? []) {
            assert.notEqual(volume.target, '/run/preview-proxy', name);
            assert.doesNotMatch(String(volume.source), /preview/, name);
          }
          // The API reads the root-only env file as a whole, so it is not checked here.
          if (name !== 'api') {
            assert.equal(service.environment?.STUDIO_PREVIEW_PASSWORD_HASH, undefined, name);
          }
        }
        // One variable for both: the API reads the same env file (its start-up guard).
        assert.equal(services.api.environment.STUDIO_PREVIEW_DOMAIN, 'preview.example.invalid');
        assert.equal(proxy.depends_on.api.condition, 'service_healthy');
        assert.equal(proxy.depends_on.web.condition, 'service_healthy');
      });

      it('refuses to render without the hash or the domain, naming the variable', () => {
        const { STUDIO_PREVIEW_PASSWORD_HASH, ...withoutHash } = PREVIEW_ENV;
        const { STUDIO_PREVIEW_DOMAIN, ...withoutDomain } = PREVIEW_ENV;
        assert.ok(STUDIO_PREVIEW_PASSWORD_HASH && STUDIO_PREVIEW_DOMAIN);
        assert.throws(() => render(files, withoutHash), /STUDIO_PREVIEW_PASSWORD_HASH/);
        assert.throws(() => render(files, withoutDomain), /STUDIO_PREVIEW_DOMAIN/);
      });
    });
  },
);

describe('fixed network defaults', () => {
  const defaults = {
    STUDIO_NETWORK_SUBNET: '172.31.250.0/24',
    STUDIO_NETWORK_DYNAMIC_RANGE: '172.31.250.128/25',
    STUDIO_POSTGRES_ADDRESS: '172.31.250.10',
    STUDIO_REDIS_ADDRESS: '172.31.250.11',
    STUDIO_API_ADDRESS: '172.31.250.12',
    STUDIO_WEB_ADDRESS: '172.31.250.13',
    STUDIO_PROXY_ADDRESS: '172.31.250.20',
  };

  it('agree between the Compose files, both scripts and the server .env template', () => {
    const compose = read('compose.server.yaml') + read('compose.server.app.yaml');
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
    for (const name of [
      'STUDIO_POSTGRES_ADDRESS',
      'STUDIO_REDIS_ADDRESS',
      'STUDIO_API_ADDRESS',
      'STUDIO_WEB_ADDRESS',
    ]) {
      const value = defaults[name].replaceAll('.', '\\.');
      assert.match(check, new RegExp(`^${name}="\\$\\{${name}:-${value}\\}"$`, 'm'), name);
    }
    assert.match(setup, /^STUDIO_PROXY_ADDRESS="\$\{STUDIO_PROXY_ADDRESS:-172\.31\.250\.20\}"$/m);
  });

  it('agree on the worker port between the setup script and the Caddyfile', () => {
    const setup = read('setup-server.sh');
    const caddyfile = read('Caddyfile');
    assert.match(setup, /^STUDIO_PROXY_WORKER_PORT="\$\{STUDIO_PROXY_WORKER_PORT:-8080\}"$/m);
    assert.match(caddyfile, /^http:\/\/:8080 \{$/m);
    // The proxy's health check uses the worker port as well.
    assert.match(read('compose.server.app.yaml'), /http:\/\/127\.0\.0\.1:8080\/api\/health/);
  });

  it('route /api to the API and the rest to the web app in the Caddyfile', () => {
    const caddyfile = read('Caddyfile');
    assert.match(caddyfile, /^\{\$STUDIO_DOMAIN\} \{$/m);
    assert.match(caddyfile, /^\ttls \{\$STUDIO_TLS\}$/m);
    assert.equal(caddyfile.match(/reverse_proxy api:3001/g)?.length, 2);
    assert.equal(caddyfile.match(/reverse_proxy web:3000/g)?.length, 1);
    // Caddy must not trust incoming X-Forwarded-* headers: no trusted_proxies anywhere.
    assert.doesNotMatch(caddyfile, /trusted_proxies/);
  });
});

describe('Preview proxy files', () => {
  const caddyfile = read('Caddyfile');
  const site = read('Caddyfile.preview');
  const code = (text) =>
    text
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

  it('imports the Preview site by glob, and checks the SNI against the Host', () => {
    assert.match(caddyfile, /^import \/etc\/caddy\/preview-site\*\.caddy$/m);
    assert.match(caddyfile, /^\t\tstrict_sni_host on$/m);
    // The import comes after the global block and before Studio's site.
    assert.ok(
      caddyfile.indexOf('import /etc/caddy/preview-site') < caddyfile.indexOf('{$STUDIO_DOMAIN} {'),
    );
    assert.doesNotMatch(caddyfile, /trusted_proxies/);
  });

  it('has one wildcard route to a socket, behind a password, with the header rules', () => {
    const body = code(site);
    assert.match(body, /^\*\.\{\$STUDIO_PREVIEW_DOMAIN\} \{$/m);
    assert.ok(body.includes('header_regexp label Host ^(preview-[0-9a-f]{12})\\.\n'));
    assert.ok(
      body.includes(
        'basic_auth bcrypt "Preview" {\n\t\t\tpreview {$STUDIO_PREVIEW_PASSWORD_HASH}\n\t\t}',
      ),
    );
    assert.equal(body.match(/reverse_proxy /g)?.length, 1);
    assert.ok(body.includes('reverse_proxy unix//run/preview-proxy/{re.label.1}.sock {'));
    for (const rule of [
      'header_up -Authorization',
      'header_up Cookie "(?:^|;)\\s*(?:__Host-)?studio_session=[^;]*" ""',
      'header_up -X-Forwarded-For',
      'header_up -Forwarded',
      'header_up -X-Real-IP',
    ]) {
      assert.ok(body.includes(`\t\t\t${rule}\n`), rule);
    }
    assert.equal(body.match(/header_up /g)?.length, 5);
    assert.match(body, /handle_errors 502 503 504 \{/);
    assert.match(body, /respond "This Preview is not running\." 404/);
    assert.match(body, /respond "Not found" 404/);
    assert.doesNotMatch(body, /^\s*(log|import|trusted_proxies|lb_try_duration|to)\b/m);
    assert.doesNotMatch(body, /\{err\./);
  });

  it('serves the operator-provided wildcard certificate files from the data volume', () => {
    assert.match(
      code(site),
      /^\ttls \/data\/preview-tls\/fullchain\.pem \/data\/preview-tls\/privkey\.pem$/m,
    );
  });

  it('agrees with PreviewHostname on the label, the 12 digits and the template', () => {
    const source = readFileSync(
      new URL(
        '../../apps/api/src/modules/environments/domain/value-objects/preview-hostname.ts',
        import.meta.url,
      ),
      'utf8',
    );
    assert.match(source, /static readonly ID_DIGITS = 12;/);
    assert.ok(source.includes('const label = `preview-${digits}`;'));
    assert.ok(source.includes('`${label}.${domain}`'));
    assert.ok(site.includes('^(preview-[0-9a-f]{12})\\.'));
    assert.ok(site.includes('/run/preview-proxy/{re.label.1}.sock'));
  });

  it('is installed by the setup script, and the wrapper adds the overlay for the domain', () => {
    const setup = read('setup-server.sh');
    assert.ok(
      setup.includes(
        'install_content "$STUDIO_COMPOSE_DIR/Caddyfile.preview" 644 <"$SCRIPT_DIR/Caddyfile.preview"',
      ),
    );
    assert.ok(
      setup.includes(
        'install_content "$STUDIO_COMPOSE_DIR/compose.preview.yaml" 600 <"$SCRIPT_DIR/compose.server.preview.yaml"',
      ),
    );
    assert.ok(setup.includes('grep -Eq \'^STUDIO_PREVIEW_DOMAIN=.+\' "$env"'));
    assert.ok(setup.includes('-f "$STUDIO_COMPOSE_DIR/compose.preview.yaml"'));
  });

  it('keeps the password hash off the agent side and the group default in one place', () => {
    assert.match(
      read('check-boundary.sh'),
      /^STUDIO_ONLY_VARS=\(.*\bSTUDIO_PREVIEW_PASSWORD_HASH\b/m,
    );
    assert.match(read('studio.env.example'), /^STUDIO_PREVIEW_PASSWORD_HASH=$/m);
    assert.ok(read('compose.server.preview.yaml').includes('${PREVIEW_PROXY_GID:-2003}'));
  });
});
