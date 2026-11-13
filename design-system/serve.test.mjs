// Tests for the design-system viewer server (Issue #53). Run: `pnpm design:test`
// (`node --test design-system/serve.test.mjs`; Node 24, no dependencies).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePort, startServer } from './serve.mjs';

const script = fileURLToPath(new URL('./serve.mjs', import.meta.url));

/** Raw HTTP request: the path is sent as written (fetch() would normalize `../` away). */
function send(port, path, method = 'GET') {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks = [];
      let aborted = false;
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('aborted', () => (aborted = true));
      res.on('error', () => (aborted = true));
      res.on('close', () =>
        resolvePromise({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          aborted: aborted || !res.complete,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/** Closes the server without waiting for a hung connection (a regression must fail, not hang). */
function stop(server) {
  return new Promise((done) => {
    server.close(done);
    server.closeAllConnections();
  });
}

/** A site root with one page, next to a secret file that must never be served. */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'design-serve-'));
  const root = join(dir, 'site');
  mkdirSync(join(root, 'nested'), { recursive: true });
  writeFileSync(join(root, 'page.html'), '<h1>page</h1>');
  writeFileSync(join(root, 'style.css'), 'body{}');
  writeFileSync(join(root, 'nested', 'index.html'), 'nested index');
  const secret = join(dir, 'secret.txt');
  writeFileSync(secret, 'TOP-SECRET-MARKER');
  return { dir, root, secret };
}

const SECRET = 'TOP-SECRET-MARKER';

describe('design-system viewer server', { timeout: 20_000 }, () => {
  const fixture = makeFixture();
  let server;
  let port;

  before(async () => {
    server = await startServer({ port: 0, root: fixture.root });
    port = server.address().port;
  });

  after(async () => {
    await stop(server);
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it('binds to 127.0.0.1 only and reports the ephemeral port', () => {
    const address = server.address();
    assert.equal(address.address, '127.0.0.1');
    assert.ok(address.port > 0);
  });

  it('serves a file with its content type', async () => {
    const res = await send(port, '/page.html');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.body, '<h1>page</h1>');
    const css = await send(port, '/style.css');
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  });

  it('serves index.html for a directory', async () => {
    const res = await send(port, '/nested/');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'nested index');
  });

  it('returns 404 for a missing file', async () => {
    const res = await send(port, '/missing.html');
    assert.equal(res.status, 404);
  });

  it('redirects / to /gallery.html', async () => {
    const res = await send(port, '/');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/gallery.html');
  });

  it('answers HEAD with the headers and no body', async () => {
    const res = await send(port, '/page.html', 'HEAD');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.headers['content-length'], String('<h1>page</h1>'.length));
    assert.equal(res.body, '');
  });

  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    it(`rejects ${method} with 405 and Allow: GET, HEAD`, async () => {
      const res = await send(port, '/page.html', method);
      assert.equal(res.status, 405);
      assert.equal(res.headers.allow, 'GET, HEAD');
      assert.ok(!res.body.includes('page'));
    });
  }

  const secretUrlPath = fixture.secret.replaceAll('\\', '/');
  const probes = [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E/secret.txt',
    '/..%2fsecret.txt',
    '/..%2Fsecret.txt',
    '/..%5csecret.txt',
    '/nested/..%5c..%5csecret.txt',
    '/%2e%2e%5csecret.txt',
    `/${secretUrlPath}`,
    `/${encodeURIComponent(fixture.secret)}`,
    '/C:/Windows/win.ini',
    '/C:%5cWindows%5cwin.ini',
    '//127.0.0.1/c$/secret.txt',
    '/%5c%5c127.0.0.1%5cc$%5csecret.txt',
    '/\\\\127.0.0.1\\c$\\secret.txt',
    '/page.html%00.txt',
    '/%00../secret.txt',
  ];
  for (const probe of probes) {
    it(`never serves content outside the root: ${probe}`, async () => {
      const res = await send(port, probe);
      assert.ok([400, 404].includes(res.status), `${probe} -> ${res.status}`);
      assert.ok(!res.body.includes(SECRET), probe);
      assert.ok(!res.body.includes('<h1>page</h1>'), probe);
    });
  }

  it('returns 404 (not 403) for a path that resolves outside the root', async () => {
    assert.equal((await send(port, '/..%2fsecret.txt')).status, 404);
  });

  it('returns 400 for a null byte in the path', async () => {
    assert.equal((await send(port, '/page.html%00.txt')).status, 400);
  });

  it('returns 400 for a malformed URL', async () => {
    assert.equal((await send(port, '/%E0%A4%A')).status, 400);
  });
});

describe('design-system viewer server: failing reads', { timeout: 20_000 }, () => {
  const fixture = makeFixture();
  let server;
  let port;
  let failMode = 'none';

  // Injected file system: real stat, read stream that fails on demand.
  const fs = {
    stat,
    createReadStream(file) {
      if (failMode === 'immediate') {
        return new Readable({
          read() {
            this.destroy(new Error('EIO: simulated read failure'));
          },
        });
      }
      if (failMode === 'midway') {
        let sent = false;
        return new Readable({
          read() {
            if (sent) this.destroy(new Error('EIO: simulated read failure'));
            else {
              sent = true;
              this.push('<h1>pa');
            }
          },
        });
      }
      return createReadStream(file);
    },
  };

  before(async () => {
    server = await startServer({ port: 0, root: fixture.root, fs });
    port = server.address().port;
  });

  after(async () => {
    await stop(server);
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it('answers 500 when the read fails before any byte is sent, then serves the next request', async () => {
    failMode = 'immediate';
    const failed = await send(port, '/page.html');
    assert.equal(failed.status, 500);
    failMode = 'none';
    const next = await send(port, '/page.html');
    assert.equal(next.status, 200);
    assert.equal(next.body, '<h1>page</h1>');
  });

  it('destroys the response when the read fails after headers were sent, then serves the next request', async () => {
    failMode = 'midway';
    const failed = await send(port, '/page.html').catch(() => ({ aborted: true }));
    assert.equal(failed.aborted, true);
    failMode = 'none';
    const next = await send(port, '/page.html');
    assert.equal(next.status, 200);
    assert.equal(next.body, '<h1>page</h1>');
  });
});

describe('parsePort', { timeout: 20_000 }, () => {
  it('takes the argument first, then PORT, then 4400', () => {
    assert.equal(parsePort('5000', '6000'), 5000);
    assert.equal(parsePort(undefined, '6000'), 6000);
    assert.equal(parsePort(undefined, undefined), 4400);
  });

  it('accepts the full port range, 0 meaning any free port', () => {
    assert.equal(parsePort('0'), 0);
    assert.equal(parsePort('65535'), 65535);
  });

  for (const value of ['abc', '', '12abc', '-1', '65536', '1.5', '1e3', ' 80']) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      assert.throws(() => parsePort(value), /Invalid port/);
    });
  }
});

/** Runs the CLI and resolves on exit, or once `until` matches stdout (then stops the process). */
function runCli(args, { env = {}, until } = {}) {
  return new Promise((resolvePromise, reject) => {
    const { PORT: _ignored, ...inherited } = process.env;
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...inherited, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out. stdout: ${stdout} stderr: ${stderr}`));
    }, 10_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = until?.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolvePromise({ match, child, stdout, stderr });
      }
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

describe('serve.mjs CLI', { timeout: 20_000 }, () => {
  for (const [label, args, env] of [
    ['a non-numeric argument', ['abc'], {}],
    ['an out-of-range argument', ['70000'], {}],
    ['a non-numeric PORT', [], { PORT: 'http' }],
  ]) {
    it(`prints one clear line and exits non-zero for ${label}`, async () => {
      const { code, stdout, stderr } = await runCli(args, { env });
      assert.notEqual(code, 0);
      assert.equal(stdout, '');
      const lines = stderr.trim().split(/\r?\n/);
      assert.equal(lines.length, 1, stderr);
      assert.match(lines[0], /Invalid port/);
    });
  }

  it('prints one clear line and exits non-zero when the port is in use', async () => {
    const fixture = makeFixture();
    const busy = await startServer({ port: 0, root: fixture.root });
    try {
      const { code, stderr } = await runCli([String(busy.address().port)]);
      assert.notEqual(code, 0);
      const lines = stderr.trim().split(/\r?\n/);
      assert.equal(lines.length, 1, stderr);
      assert.match(lines[0], /already in use/);
    } finally {
      await stop(busy);
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('serves the real design system on 127.0.0.1 and redirects / to the gallery', async () => {
    const { match, child } = await runCli(['0'], {
      until: /http:\/\/127\.0\.0\.1:(\d+)\/gallery\.html/,
    });
    try {
      const cliPort = Number(match[1]);
      assert.ok(cliPort > 0);
      const root = await send(cliPort, '/');
      assert.equal(root.status, 302);
      assert.equal(root.headers.location, '/gallery.html');
      const gallery = await send(cliPort, '/gallery.html');
      assert.equal(gallery.status, 200);
      assert.equal(gallery.headers['content-type'], 'text/html; charset=utf-8');
      const outside = await send(cliPort, '/..%2fpackage.json');
      assert.equal(outside.status, 404);
      assert.ok(!outside.body.includes('agentic-studio'));
    } finally {
      child.kill();
    }
  });
});
