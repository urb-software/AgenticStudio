// Runs the real Caddy with the Preview site against stand-in sockets (docs/engineering/deployment.md, "What CI covers").
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const deployDir = new URL('..', import.meta.url);
const file = (name) => fileURLToPath(new URL(name, deployDir));
const linux = process.platform === 'linux';
const ci = process.env.CI === 'true';

function dockerAvailable() {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const docker = linux && dockerAvailable();
const skip = !linux
  ? 'needs Linux and Docker (runs in CI job deploy:server)'
  : !docker && !ci
    ? 'needs Docker'
    : false;

const PREVIEW_UID = '2002';
const PROXY_GID = '2003';
const root = process.getuid?.() === 0;
const image = readFileSync(file('compose.server.app.yaml'), 'utf8').match(
  /image: (caddy:\S+@sha256:[0-9a-f]{64})/,
)?.[1];

/** Runs a command as root (directly, or through `sudo -n`). */
function asRoot(command, args, options = {}) {
  return root
    ? execFileSync(command, args, { encoding: 'utf8', ...options })
    : execFileSync('sudo', ['-n', command, ...args], { encoding: 'utf8', ...options });
}
/** The command line that runs `command` with a given uid, gid and supplementary groups. */
function withIdentity(uid, gid, groups, command, args) {
  const identity = [
    `--reuid=${uid}`,
    `--regid=${gid}`,
    groups ? `--groups=${groups}` : '--clear-groups',
  ];
  return root
    ? ['setpriv', [...identity, command, ...args]]
    : ['sudo', ['-n', 'setpriv', ...identity, command, ...args]];
}

const tmp = mkdtempSync(join(tmpdir(), 'preview-proxy-'));
chmodSync(tmp, 0o755);
const socketDir = join(tmp, 'sockets');
const certDir = join(tmp, 'certs');
const password = randomBytes(18).toString('base64url');
const wrongPassword = `${password}-wrong`;
let passwordHash;

const LABEL = {
  one: 'preview-aaaaaaaaaaaa',
  two: 'preview-bbbbbbbbbbbb',
  missing: 'preview-cccccccccccc',
  stale: 'preview-dddddddddddd',
  flapping: 'preview-eeeeeeeeeeee',
};
const PREVIEW_DOMAIN = 'preview.test';
const STUDIO_DOMAIN = 'studio.test';

// ---- stand-ins -------------------------------------------------------------------------------

/** Studio's api (3001) and web (3000) as the proxy reaches them: through the host gateway. */
const studio = { api: [], web: [] };
const studioServers = [];
function listenStudio(name, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      studio[name].push(request.headers.host);
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(name);
    });
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
    studioServers.push(server);
  });
}

let standin;
const hits = [];
const waiting = new Map();
function startStandin() {
  const script = join(tmp, 'preview-standin.mjs');
  copyFileSync(file('tests/preview-standin.mjs'), script);
  chmodSync(script, 0o755);
  asRoot('install', ['-d', '-o', PREVIEW_UID, '-g', PROXY_GID, '-m', '0750', socketDir]);
  const [command, args] = withIdentity(PREVIEW_UID, PROXY_GID, null, process.execPath, [
    script,
    socketDir,
  ]);
  standin = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  let buffered = '';
  standin.stdout.on('data', (chunk) => {
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf('\n');
      if (end < 0) break;
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line.startsWith('hit ')) hits.push(line.slice(4));
      else waiting.get(line)?.(line);
    }
  });
}
/** Sends one control line and waits for its `ok` line. */
function control(command, label) {
  return new Promise((resolve, reject) => {
    const reply = `ok ${command} ${label}`;
    const timer = setTimeout(() => reject(new Error(`no reply to "${command} ${label}"`)), 10_000);
    waiting.set(reply, () => {
      clearTimeout(timer);
      waiting.delete(reply);
      resolve();
    });
    standin.stdin.write(`${command} ${label}\n`);
  });
}
const hitsFor = (label) => hits.filter((hit) => hit === label).length;

// ---- Caddy -----------------------------------------------------------------------------------

const proxies = [];
/** Caddy logs to stderr: both streams. */
const dockerLogs = (name) => {
  const { stdout, stderr } = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
  return `${stdout}${stderr}`;
};
const dockerOut = (args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

/** Starts the proxy like deploy/compose.server*.yaml does; returns its published ports. */
async function startProxy({ studioDomain, previewDomain, tlsDir = certDir, refuses = false }) {
  const name = `preview-proxy-test-${randomBytes(4).toString('hex')}`;
  const args = [
    'run', '-d', '--name', name,
    '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'NET_BIND_SERVICE',
    '--security-opt', 'no-new-privileges:true',
    '--tmpfs', '/tmp', '--tmpfs', '/config', '--tmpfs', '/data:uid=10001,gid=10001,mode=0700',
    '--add-host', 'api:host-gateway', '--add-host', 'web:host-gateway',
    '-p', '127.0.0.1::443', '-p', '127.0.0.1::80',
    '-e', `STUDIO_DOMAIN=${studioDomain}`, '-e', 'STUDIO_TLS=internal',
    '-v', `${file('Caddyfile')}:/etc/caddy/Caddyfile:ro`,
  ]; // prettier-ignore
  if (previewDomain) {
    args.push(
      '--group-add', PROXY_GID,
      '-e', `STUDIO_PREVIEW_DOMAIN=${previewDomain}`,
      '-e', `STUDIO_PREVIEW_PASSWORD_HASH=${passwordHash}`,
      '-v', `${file('Caddyfile.preview')}:/etc/caddy/preview-site.caddy:ro`,
      '-v', `${socketDir}:/run/preview-proxy:ro`,
      '-v', `${tlsDir}:/data/preview-tls:ro`,
    ); // prettier-ignore
  }
  args.push(image, 'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile');
  dockerOut(args);
  proxies.push(name);
  const port = (target) => Number(dockerOut(['port', name, `${target}/tcp`]).match(/:(\d+)$/m)[1]);
  const proxy = { name, https: port(443), http: port(80), ca: [] };
  for (let attempt = 0; ; attempt++) {
    const running = dockerOut(['inspect', '-f', '{{.State.Running}}', name]) === 'true';
    if (!running) {
      if (refuses) {
        const exitCode = Number(dockerOut(['inspect', '-f', '{{.State.ExitCode}}', name]));
        return { name, exitCode, logs: dockerLogs(name) };
      }
      throw new Error(`proxy stopped:\n${dockerLogs(name)}`);
    }
    try {
      // Trust only the throwaway wildcard certificate and this proxy's own internal CA.
      const root = dockerOut(['exec', name, 'cat', '/data/caddy/pki/authorities/local/root.crt']);
      proxy.ca = [root, readFileSync(join(certDir, 'fullchain.pem'), 'utf8')];
      const answer = await request(proxy, { host: studioDomain, path: '/api/health' });
      if (answer.status === 200) return proxy;
    } catch {
      // Not listening yet.
    }
    if (attempt > 80 && refuses) throw new Error('the proxy did not refuse to start');
    if (attempt > 80) throw new Error(`proxy not ready:\n${dockerLogs(name)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// ---- clients ---------------------------------------------------------------------------------

const basic = (secret, user = 'preview') =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;

/** An HTTPS request to the proxy; the Host header carries the published port, as a browser's. */
function request(proxy, { host, sni = host, path = '/', headers = {}, secret, authHost }) {
  const hostHeader = authHost ?? `${host}:${proxy.https}`;
  const all = { Host: hostHeader, ...headers };
  if (secret !== undefined) all.Authorization = basic(secret);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: proxy.https,
        servername: sni,
        path,
        headers: all,
        agent: false,
        ca: proxy.ca,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body,
            host: hostHeader,
            json: () => JSON.parse(body),
          });
        });
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** The same over HTTP/2, with header fields given as an object (arrays repeat the field). */
function request2(proxy, { host, path = '/', headers = {}, secret }) {
  const authority = `${host}:${proxy.https}`;
  const fields = { ':path': path, ':authority': authority, ...headers };
  if (secret !== undefined) fields.authorization = basic(secret);
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://127.0.0.1:${proxy.https}`, {
      ca: proxy.ca,
      servername: host,
    });
    client.on('error', reject);
    const req = client.request(fields);
    let responseHeaders;
    const chunks = [];
    req.on('response', (received) => (responseHeaders = received));
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      client.close();
      const body = Buffer.concat(chunks).toString('utf8');
      resolve({
        status: responseHeaders[':status'],
        headers: responseHeaders,
        body,
        host: authority,
        json: () => JSON.parse(body),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** A plain-HTTP request to the proxy's port 80: it must only redirect. */
function requestPlain(proxy, { host, path = '/' }) {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: '127.0.0.1', port: proxy.http, path, headers: { Host: host }, agent: false },
        (response) => {
          response.resume();
          response.on('end', () =>
            resolve({ status: response.statusCode, headers: response.headers }),
          );
        },
      )
      .on('error', reject);
  });
}

/** A WebSocket client over TLS: the status line, the first text frame and an echo round trip. */
function webSocket(proxy, { host, headers = {}, secret }) {
  const all = {
    Host: `${host}:${proxy.https}`,
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    'Sec-WebSocket-Version': '13',
    ...headers,
  };
  if (secret !== undefined) all.Authorization = basic(secret);
  const lines = Object.entries(all).map(([name, value]) => `${name}: ${value}\r\n`);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port: proxy.https,
      servername: host,
      ca: proxy.ca,
    });
    let buffer = Buffer.alloc(0);
    let status;
    let handshake = false;
    const texts = [];
    const waiters = [];
    const settle = () => {
      if (!handshake) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        status = Number(
          buffer
            .subarray(0, end)
            .toString()
            .match(/^HTTP\/1\.1 (\d+)/)?.[1],
        );
        buffer = buffer.subarray(end + 4);
        handshake = true;
        if (status !== 101) {
          socket.destroy();
          return resolve({ status, close() {} });
        }
        resolve({
          status,
          next: () =>
            new Promise((done) => (texts.length ? done(texts.shift()) : waiters.push(done))),
          send(text) {
            const payload = Buffer.from(text);
            const mask = randomBytes(4);
            const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
            socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
          },
          close: () => socket.destroy(),
        });
      }
      while (buffer.length >= 2) {
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 127) throw new Error('frame too large for the test');
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (buffer.length < offset + length) return;
        const text = buffer.subarray(offset, offset + length).toString('utf8');
        buffer = buffer.subarray(offset + length);
        if (waiters.length) waiters.shift()(text);
        else texts.push(text);
      }
    };
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      settle();
    });
    socket.on('error', reject);
    socket.on('secureConnect', () => socket.write(`GET / HTTP/1.1\r\n${lines.join('')}\r\n`));
  });
}

// ---- tests -----------------------------------------------------------------------------------

describe('Preview site of the reverse proxy', { skip }, () => {
  let main;
  const previewHost = (label) => `${label}.${PREVIEW_DOMAIN}`;
  const ask = (label, options = {}) =>
    request(main, { host: previewHost(label), secret: password, ...options });

  before(async () => {
    assert.ok(docker, 'Docker is required in CI');
    assert.ok(image, 'the pinned proxy image is in compose.server.app.yaml');
    // A throwaway wildcard certificate, readable by the proxy's uid.
    mkdirSync(certDir, { mode: 0o755 });
    chmodSync(certDir, 0o755);
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(certDir, 'privkey.pem'), '-out', join(certDir, 'fullchain.pem'),
      '-days', '2', '-subj', `/CN=${PREVIEW_DOMAIN}`,
      '-addext', `subjectAltName=DNS:*.${PREVIEW_DOMAIN},DNS:${PREVIEW_DOMAIN}`,
    ], { stdio: ['ignore', 'ignore', 'inherit'] }); // prettier-ignore
    chmodSync(join(certDir, 'privkey.pem'), 0o644);
    chmodSync(join(certDir, 'fullchain.pem'), 0o644);
    passwordHash = dockerOut([
      'run',
      '--rm',
      image,
      'caddy',
      'hash-password',
      '--plaintext',
      password,
    ]);
    assert.match(passwordHash, /^\$2[aby]\$/);

    await listenStudio('api', 3001);
    await listenStudio('web', 3000);
    startStandin();
    for (const label of [LABEL.one, LABEL.two, LABEL.flapping]) await control('up', label);
    await control('stale', LABEL.stale);
    main = await startProxy({ studioDomain: STUDIO_DOMAIN, previewDomain: PREVIEW_DOMAIN });
  });

  after(async () => {
    for (const name of proxies) {
      try {
        dockerOut(['rm', '-f', name]);
      } catch {
        // Already gone.
      }
    }
    try {
      standin?.stdin.write('quit\n');
      standin?.kill();
    } catch {
      // Already gone.
    }
    for (const server of studioServers) server.close();
    try {
      asRoot('rm', ['-rf', tmp]);
    } catch {
      // Best effort: the directory is under the temporary directory.
    }
  });

  it('serves Studio on its host: api and web, and never a Preview socket', async () => {
    const before = hits.length;
    const health = await request(main, { host: STUDIO_DOMAIN, path: '/api/health' });
    const login = await request(main, { host: STUDIO_DOMAIN, path: '/login' });
    assert.equal(health.status, 200);
    assert.equal(health.body, 'api');
    assert.equal(login.status, 200);
    assert.equal(login.body, 'web');
    assert.equal(hits.length, before);
    // No password prompt on Studio's host.
    assert.equal(health.headers['www-authenticate'], undefined);
  });

  it('asks for the password first: 401 with WWW-Authenticate, nothing reaches the Preview', async () => {
    const attempts = [
      await request(main, { host: previewHost(LABEL.one) }),
      await ask(LABEL.one, { secret: wrongPassword }),
      await request(main, { host: previewHost(LABEL.one), headers: { Authorization: basic(password, 'other') } }),
    ]; // prettier-ignore
    for (const attempt of attempts) {
      assert.equal(attempt.status, 401);
      assert.match(attempt.headers['www-authenticate'], /^Basic /);
    }
    // A Preview that does not exist asks the same, so the answer never says which exist.
    const missing = await request(main, { host: previewHost(LABEL.missing) });
    assert.equal(missing.status, 401);
    assert.equal(hitsFor(LABEL.one), 0);
    const served = await ask(LABEL.one);
    assert.equal(served.status, 200);
    assert.equal(served.json().label, LABEL.one);
    assert.equal(hitsFor(LABEL.one), 1);
  });

  it('shows the Preview its own headers only: no Authorization, no Studio cookie, no client address', async () => {
    const address = {
      'X-Forwarded-For': '203.0.113.9',
      Forwarded: 'for=203.0.113.9;proto=http',
      'X-Real-IP': '203.0.113.9',
    };
    const names = (cookie) =>
      (cookie ?? '')
        .split(';')
        .map((pair) => pair.trim().split('=')[0])
        .filter(Boolean);
    const check = (answer, keep) => {
      assert.equal(answer.status, 200);
      const seen = answer.json().headers;
      assert.equal(seen.authorization, undefined);
      const cookies = names(seen.cookie);
      assert.deepEqual(cookies.sort(), [...keep].sort(), String(seen.cookie));
      assert.doesNotMatch(seen.cookie ?? '', /studiovalue/);
      for (const name of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
        assert.equal(seen[name], undefined, name);
      }
      assert.equal(seen['x-forwarded-proto'], 'https');
      assert.equal(seen['x-forwarded-host'], answer.host);
      assert.equal(seen.host, answer.host);
    };
    // The Studio cookie under both names is removed wherever it stands; look-alikes stay.
    const cases = [
      ['studio_session=studiovalue; app=keep; __Host-studio_session=studiovalue2; theme=dark', ['app', 'theme']],
      ['app=keep; theme=dark; studio_session=studiovalue', ['app', 'theme']],
      ['app=keep; __Host-studio_session=studiovalue', ['app']],
      ['studio_session=studiovalue', []],
      ['__Host-studio_session=studiovalue', []],
      ['xstudio_session=keep; studio_session=studiovalue; studio_session_x=keep', ['xstudio_session', 'studio_session_x']],
    ]; // prettier-ignore
    for (const [cookie, keep] of cases) {
      check(await ask(LABEL.one, { headers: { Cookie: cookie, ...address } }), keep);
    }
    check(
      await request2(main, {
        host: previewHost(LABEL.one),
        secret: password,
        headers: {
          cookie: ['studio_session=studiovalue; app=keep', '__Host-studio_session=studiovalue2; theme=dark'],
          'x-forwarded-for': address['X-Forwarded-For'],
          forwarded: address.Forwarded,
          'x-real-ip': address['X-Real-IP'],
        },
      }),
      ['app', 'theme'],
    ); // prettier-ignore
  });

  it('answers "not running" for a missing or a stale socket, never another Preview', async () => {
    for (const label of [LABEL.missing, LABEL.stale]) {
      const answer = await ask(label);
      assert.equal(answer.status, 404, label);
      assert.match(answer.headers['content-type'], /^text\/plain/);
      assert.equal(answer.body, 'This Preview is not running.');
    }
    assert.equal(hitsFor(LABEL.two), 0);
  });

  it('follows the socket: removed gives "not running", created again serves, no restart', async () => {
    await control('up', LABEL.flapping);
    assert.equal((await ask(LABEL.flapping)).status, 200);
    await control('down', LABEL.flapping);
    const gone = await ask(LABEL.flapping);
    assert.equal(gone.status, 404);
    assert.equal(gone.body, 'This Preview is not running.');
    await control('up', LABEL.flapping);
    const back = await ask(LABEL.flapping);
    assert.equal(back.status, 200);
    assert.equal(back.json().label, LABEL.flapping);
  });

  it('refuses other hostnames with 404 and no password prompt', async () => {
    const refused = [
      'preview-aaaaaaaaaaa', // 11 hex digits
      'preview-aaaaaaaaaaaaa', // 13
      'preview-AAAAAAAAAAAA', // upper case
      'preview-gggggggggggg', // not hex
      'other-aaaaaaaaaaaa',
      'www',
    ];
    const before = hits.length;
    for (const label of refused) {
      const answer = await request(main, { host: previewHost(label) });
      assert.equal(answer.status, 404, label);
      assert.equal(answer.body, 'Not found', label);
      assert.equal(answer.headers['www-authenticate'], undefined, label);
    }
    // Two labels: not the wildcard's host at all.
    // No certificate covers it, so Caddy ends the TLS handshake; if a client got through
    // anyway, the answer must still be a refusal with no prompt.
    const two = await request(main, { host: `${LABEL.one}.extra.${PREVIEW_DOMAIN}` }).catch(
      (error) => ({ status: 'tls-refused', headers: {}, error }),
    );
    assert.ok(['tls-refused', 404].includes(two.status), String(two.status));
    assert.equal(two.headers['www-authenticate'], undefined);
    assert.equal(hits.length, before);
  });

  it('never lets hosts cross: no Studio service for a Preview, 421 on SNI mismatch, http only redirects', async () => {
    const api = studio.api.length;
    const web = studio.web.length;
    for (const label of [LABEL.one, LABEL.missing, LABEL.stale, 'preview-zz']) {
      await request(main, { host: previewHost(label), path: '/api/health' });
      await ask(label, { path: '/api/health' });
      await ask(label, { path: '/login' });
    }
    assert.equal(studio.api.length, api);
    assert.equal(studio.web.length, web);

    const before = hits.length;
    const previewViaStudio = await request(main, {
      host: previewHost(LABEL.one),
      sni: STUDIO_DOMAIN,
      secret: password,
    });
    assert.equal(previewViaStudio.status, 421);
    const studioViaPreview = await request(main, {
      host: STUDIO_DOMAIN,
      sni: previewHost(LABEL.one),
      path: '/api/health',
    });
    assert.equal(studioViaPreview.status, 421);
    assert.equal(hits.length, before);
    assert.equal(studio.api.length, api);

    for (const host of [previewHost(LABEL.one), STUDIO_DOMAIN]) {
      const plain = await requestPlain(main, { host });
      assert.ok([301, 302, 307, 308].includes(plain.status), `${host}: ${plain.status}`);
      assert.match(plain.headers.location, /^https:\/\//);
    }
    assert.equal(hits.length, before);
  });

  it('passes a WebSocket with the password and the same header rules; 401 without it', async () => {
    const socket = await webSocket(main, {
      host: previewHost(LABEL.two),
      secret: password,
      headers: {
        Cookie: 'studio_session=studiovalue; app=keep',
        'X-Forwarded-For': '203.0.113.9',
        Forwarded: 'for=203.0.113.9',
        'X-Real-IP': '203.0.113.9',
      },
    });
    assert.equal(socket.status, 101);
    const seen = JSON.parse(await socket.next()).headers;
    assert.equal(seen.authorization, undefined);
    for (const name of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
      assert.equal(seen[name], undefined, name);
    }
    assert.match(seen.cookie, /app=keep/);
    assert.doesNotMatch(seen.cookie, /studio_session/);
    socket.send('hello-preview');
    assert.equal(await socket.next(), 'echo:hello-preview');
    socket.close();

    const before = hits.length;
    const refused = await webSocket(main, { host: previewHost(LABEL.two) });
    assert.equal(refused.status, 401);
    assert.equal(hits.length, before);
  });

  it('cannot be reached by a user outside the socket group (EACCES)', () => {
    const probe =
      "require('net').connect(process.argv[1]).on('connect',()=>{console.log('connected');process.exit(0)})" +
      ".on('error',(e)=>{console.log(e.code);process.exit(0)})";
    const socketPath = join(socketDir, `${LABEL.one}.sock`);
    const run = (groups) => {
      const [command, args] = withIdentity('65534', '65534', groups, process.execPath, ['-e', probe, socketPath]);
      return execFileSync(command, args, { encoding: 'utf8' }).trim();
    }; // prettier-ignore
    assert.equal(run(null), 'EACCES');
    // Control: the same user with the proxy's group connects, so the refusal is the mode.
    assert.equal(run(PROXY_GID), 'connected');
  });

  it('refuses to start when the certificate files are missing', async () => {
    const empty = join(tmp, 'no-certs');
    mkdirSync(empty, { mode: 0o755 });
    chmodSync(empty, 0o755);
    const stopped = await startProxy({
      studioDomain: STUDIO_DOMAIN,
      previewDomain: PREVIEW_DOMAIN,
      tlsDir: empty,
      refuses: true,
    });
    assert.notEqual(stopped.exitCode, 0);
    assert.match(stopped.logs, /preview-tls|fullchain|certificate/i);
  });

  it('starts and serves Studio without the Preview site when Previews are off', async () => {
    const off = await startProxy({ studioDomain: STUDIO_DOMAIN, previewDomain: null });
    const login = await request(off, { host: STUDIO_DOMAIN, path: '/login' });
    assert.equal(login.status, 200);
    assert.equal(login.body, 'web');
    const info = JSON.parse(dockerOut(['inspect', off.name]))[0];
    assert.equal(info.HostConfig.GroupAdd, null);
    assert.ok(!info.Mounts.some((mount) => mount.Destination === '/run/preview-proxy'));
    assert.ok(!info.Config.Env.some((entry) => entry.startsWith('STUDIO_PREVIEW')));
  });

  it('keeps Studio reachable when its host is a name under the preview domain', async () => {
    const under = await startProxy({
      studioDomain: `studio.${PREVIEW_DOMAIN}`,
      previewDomain: PREVIEW_DOMAIN,
    });
    const login = await request(under, { host: `studio.${PREVIEW_DOMAIN}`, path: '/login' });
    assert.equal(login.status, 200);
    assert.equal(login.body, 'web');
    assert.equal(login.headers['www-authenticate'], undefined);
    // Its Previews still ask for the password and are served.
    const label = await request(under, { host: previewHost(LABEL.one) });
    assert.equal(label.status, 401);
    const served = await request(under, { host: previewHost(LABEL.one), secret: password });
    assert.equal(served.status, 200);
    // `studio` is not a Preview label.
    const refused = await request(under, { host: `studio2.${PREVIEW_DOMAIN}` });
    assert.equal(refused.status, 404);
  });
});
