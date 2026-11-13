#!/usr/bin/env node
// Zero-dependency static server for the design system (gallery, component previews, prototype).
// Usage: node design-system/serve.mjs [port]   (default 4400, or PORT env). Binds to 127.0.0.1 only.
// Importable for tests: startServer({ port: 0 }) listens on an ephemeral port (design-system/serve.test.mjs).
import { createServer } from 'node:http';
import { createReadStream, realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4400;
const DEFAULT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Port from the CLI argument, then the PORT variable, then 4400. 0 means any free port.
 * Throws `Invalid port "<value>"` for anything but an integer from 0 to 65535.
 */
export function parsePort(arg, env) {
  const raw = arg ?? env;
  if (raw === undefined) return DEFAULT_PORT;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 0 && port <= 65535)) {
    throw new Error(`Invalid port "${raw}": expected an integer from 0 to 65535.`);
  }
  return port;
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers }).end(text);
}

const defaultFileSystem = { stat, realpath, createReadStream };

/** True when `file` is `root` itself or below it. */
function isInside(root, file) {
  return file === root || file.startsWith(root + sep);
}

/**
 * Request handler serving files under `root` (`realRoot` is its resolved real path).
 * `files` ({ stat, realpath, createReadStream }) is injectable for tests.
 */
function createHandler(root, realRoot, files) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', `http://${HOST}`).pathname);
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }
    if (pathname.includes('\0')) {
      sendText(res, 400, 'Bad request');
      return;
    }
    if (pathname === '/') {
      res.writeHead(302, { location: '/gallery.html' }).end();
      return;
    }
    let file = normalize(join(root, pathname));
    // Anything resolving outside the root is reported as missing, never as forbidden.
    if (!isInside(root, file)) {
      sendText(res, 404, 'Not found');
      return;
    }
    let info = await files.stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await files.stat(file).catch(() => null);
    }
    // Links are followed only while their target stays inside the root, too.
    const realFile = info?.isFile() ? await files.realpath(file).catch(() => null) : null;
    if (!realFile || !isInside(realRoot, realFile)) {
      sendText(res, 404, 'Not found');
      return;
    }
    // Implicit headers: they are only sent with the first body chunk, so a read that fails
    // before any byte can still become a 500.
    res.statusCode = 200;
    res.setHeader('content-type', types[extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('content-length', info.size);
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = files.createReadStream(realFile);
    stream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      for (const name of res.getHeaderNames()) res.removeHeader(name);
      sendText(res, 500, 'Internal server error');
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };
}

/**
 * Starts the server on 127.0.0.1 and resolves with the listening `http.Server`
 * (`server.address().port` is the bound port). Rejects on listen errors such as EADDRINUSE.
 * `fileSystem` overrides parts of { stat, realpath, createReadStream } (tests only).
 */
export function startServer({ port = DEFAULT_PORT, root = DEFAULT_ROOT, fileSystem = {} } = {}) {
  const absoluteRoot = resolve(root);
  const handler = createHandler(absoluteRoot, realpathSync(absoluteRoot), {
    ...defaultFileSystem,
    ...fileSystem,
  });
  const server = createServer(handler);
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolvePromise(server);
    });
  });
}

async function main() {
  let port;
  try {
    port = parsePort(process.argv[2], process.env.PORT);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  let server;
  try {
    server = await startServer({ port });
  } catch (error) {
    console.error(
      error.code === 'EADDRINUSE'
        ? `Port ${port} on ${HOST} is already in use; pass another port: node design-system/serve.mjs <port>`
        : `Cannot listen on ${HOST}:${port}: ${error.message}`,
    );
    process.exitCode = 1;
    return;
  }
  const base = `http://${HOST}:${server.address().port}`;
  console.log(`Design system served from ${DEFAULT_ROOT}`);
  console.log(`  Gallery:    ${base}/gallery.html`);
  console.log(`  Prototype:  ${base}/prototype/agent-studio-prototype.dc.html?startSignedIn=true`);
  console.log('Ctrl+C to stop.');
}

/** True when this file is the process entry point (`node design-system/serve.mjs`), not an import. */
function isEntryPoint() {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntryPoint()) await main();
