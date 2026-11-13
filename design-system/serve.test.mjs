// Tests for the design-system viewer server (Issue #53). Run: `pnpm design:test`
// (`node --test design-system/serve.test.mjs`; Node 24, no dependencies).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  // Canonical (native) spelling, so the fixtures also work when tmpdir() is an 8.3 short path.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'design-serve-')));
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

  // [label, raw request path, expected status]. Every probe must also serve nothing.
  // The drive-letter and UNC forms only reach outside the root on Windows; on Linux they resolve
  // inside the root and prove that absolute paths are joined, not followed. The `..` forms are the
  // cross-platform containment probes.
  const secretUrlPath = fixture.secret.replaceAll('\\', '/');
  const probes = [
    ['plain ../ (normalized by the URL parser)', '/../secret.txt', 404],
    ['%2e%2e/', '/%2e%2e/secret.txt', 404],
    ['%2E%2E/ (upper case)', '/%2E%2E/secret.txt', 404],
    ['..%2f', '/..%2fsecret.txt', 404],
    ['..%2F (upper case)', '/..%2Fsecret.txt', 404],
    ['..%5c', '/..%5csecret.txt', 404],
    ['nested ..%5c..%5c', '/nested/..%5c..%5csecret.txt', 404],
    ['%2e%2e%5c', '/%2e%2e%5csecret.txt', 404],
    ['absolute path of the secret (drive letter on Windows)', `/${secretUrlPath}`, 404],
    ['encoded absolute path', `/${encodeURIComponent(fixture.secret)}`, 404],
    ['drive letter C:/ (Windows form)', '/C:/Windows/win.ini', 404],
    ['drive letter C:%5c (Windows form)', '/C:%5cWindows%5cwin.ini', 404],
    ['UNC //host/share (Windows form)', '//127.0.0.1/c$/secret.txt', 404],
    ['UNC %5c%5chost%5cshare (Windows form)', '/%5c%5c127.0.0.1%5cc$%5csecret.txt', 404],
    ['UNC raw backslashes (Windows form)', '/\\\\127.0.0.1\\c$\\secret.txt', 404],
    ['null byte', '/page.html%00.txt', 400],
    ['null byte before ..', '/%00../secret.txt', 400],
    ['malformed percent-encoding', '/%E0%A4%A', 400],
  ];
  for (const [label, probe, status] of probes) {
    it(`answers ${status} and serves nothing for ${label}: ${probe}`, async () => {
      const res = await send(port, probe);
      assert.equal(res.status, status, probe);
      assert.ok(!res.body.includes(SECRET), probe);
      assert.ok(!res.body.includes('<h1>page</h1>'), probe);
    });
  }
});

/** A read stream factory that pushes `prefix` (if any) and then fails. */
function failingStream(prefix) {
  return () => {
    let sent = !prefix;
    return new Readable({
      read() {
        if (sent) this.destroy(new Error('EIO: simulated read failure'));
        else {
          sent = true;
          this.push(prefix);
        }
      },
    });
  };
}

describe('design-system viewer server: failing reads', { timeout: 20_000 }, () => {
  const fixture = makeFixture();
  after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  /** Runs `check` against a server whose first read fails with `failing`; later reads are real. */
  async function withFailingRead(failing, check) {
    let failNext = true;
    const server = await startServer({
      port: 0,
      root: fixture.root,
      fileSystem: {
        createReadStream(file) {
          if (!failNext) return createReadStream(file);
          failNext = false;
          return failing();
        },
      },
    });
    try {
      await check(server.address().port);
    } finally {
      await stop(server);
    }
  }

  it('answers 500 when the read fails before any byte is sent, then serves the next request', async () => {
    await withFailingRead(failingStream(), async (port) => {
      const failed = await send(port, '/page.html');
      assert.equal(failed.status, 500);
      const next = await send(port, '/page.html');
      assert.equal(next.status, 200);
      assert.equal(next.body, '<h1>page</h1>');
    });
  });

  it('destroys the response when the read fails after headers were sent, then serves the next request', async () => {
    await withFailingRead(failingStream('<h1>pa'), async (port) => {
      const failed = await send(port, '/page.html').catch(() => ({ aborted: true }));
      assert.equal(failed.aborted, true);
      const next = await send(port, '/page.html');
      assert.equal(next.status, 200);
      assert.equal(next.body, '<h1>page</h1>');
    });
  });
});

/**
 * Creates a link at `path` to `target` and returns null, or returns why it cannot. Directory
 * links are junctions on Windows (no privilege needed); file symlinks need privilege there.
 */
function tryLink(target, path, type) {
  try {
    symlinkSync(target, path, type === 'dir' && process.platform === 'win32' ? 'junction' : type);
    return null;
  } catch (error) {
    return `cannot create a ${type} link on this machine (${error.code})`;
  }
}

describe('design-system viewer server: links', { timeout: 20_000 }, () => {
  const fixture = makeFixture();
  const outside = join(fixture.dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'leak.txt'), SECRET);
  writeFileSync(join(outside, 'index.html'), SECRET);
  writeFileSync(join(fixture.root, 'inner.txt'), 'inner');
  const dirLinkError = tryLink(outside, join(fixture.root, 'link-dir'), 'dir');
  const fileLinkError = tryLink(fixture.secret, join(fixture.root, 'link-file.txt'), 'file');
  const innerLinkError = tryLink(
    join(fixture.root, 'inner.txt'),
    join(fixture.root, 'inner-link.txt'),
    'file',
  );
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

  it('answers 404 for files reached through a directory link pointing outside', async (t) => {
    if (dirLinkError) return t.skip(dirLinkError);
    for (const path of ['/link-dir/leak.txt', '/link-dir/', '/link-dir']) {
      const res = await send(port, path);
      assert.equal(res.status, 404, path);
      assert.ok(!res.body.includes(SECRET), path);
    }
  });

  it('answers 404 for a file link pointing outside', async (t) => {
    if (fileLinkError) return t.skip(fileLinkError);
    const res = await send(port, '/link-file.txt');
    assert.equal(res.status, 404);
    assert.ok(!res.body.includes(SECRET));
  });

  it('still serves a file link that stays inside the root', async (t) => {
    if (innerLinkError) return t.skip(innerLinkError);
    const res = await send(port, '/inner-link.txt');
    assert.equal(res.status, 200);
    assert.equal(res.body, 'inner');
  });
});

/** The Windows 8.3 short spelling of `path`, or null when the volume has none. */
function shortPath(path) {
  try {
    const short = execFileSync('cmd.exe', ['/d', '/c', `for %I in ("${path}") do @echo %~sI`], {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
    }).trim();
    return short && short.toLowerCase() !== path.toLowerCase() ? short : null;
  } catch {
    return null;
  }
}

describe('design-system viewer server: root spellings', { timeout: 20_000 }, () => {
  const fixture = makeFixture();
  const outside = join(fixture.dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'leak.txt'), SECRET);
  const linkError = tryLink(outside, join(fixture.root, 'link-dir'), 'dir');
  const rootLink = join(fixture.dir, 'root-link');
  const rootLinkError = tryLink(fixture.root, rootLink, 'dir');
  after(() => rmSync(fixture.dir, { recursive: true, force: true }));

  const windows = process.platform === 'win32';
  const notWindows = 'case-insensitive paths and 8.3 names are Windows-only';
  const short = windows ? shortPath(fixture.root) : null;
  const spellings = [
    ['in upper case', fixture.root.toUpperCase(), windows ? null : notWindows],
    ['in lower case', fixture.root.toLowerCase(), windows ? null : notWindows],
    [
      'as an 8.3 short name',
      short,
      windows ? (short ? null : 'no 8.3 short name on this volume') : notWindows,
    ],
    ['through a link', rootLink, rootLinkError],
  ];

  for (const [label, root, skipReason] of spellings) {
    it(`serves files and still contains links with the root spelled ${label}`, async (t) => {
      if (skipReason) return t.skip(skipReason);
      const server = await startServer({ port: 0, root });
      try {
        const port = server.address().port;
        const page = await send(port, '/page.html');
        assert.equal(page.status, 200, `${root}: /page.html`);
        assert.equal(page.body, '<h1>page</h1>');
        assert.equal((await send(port, '/nested/')).status, 200, `${root}: /nested/`);
        if (!linkError) {
          const leak = await send(port, '/link-dir/leak.txt');
          assert.equal(leak.status, 404, `${root}: /link-dir/leak.txt`);
          assert.ok(!leak.body.includes(SECRET));
        }
      } finally {
        await stop(server);
      }
    });
  }
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

/** Kills a CLI child process and waits until it has exited. */
function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    child.once('exit', done);
    child.kill();
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
      await stopChild(child);
    }
  });
});
