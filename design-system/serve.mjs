#!/usr/bin/env node
// Zero-dependency static server for the design system (gallery, component previews, prototype).
// Usage: node design-system/serve.mjs [port]   (default 4400, or PORT env). Binds to 127.0.0.1 only.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.argv[2] ?? process.env.PORT ?? 4400);
const host = '127.0.0.1';

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

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? '/', `http://${host}`);
    let file = normalize(join(root, decodeURIComponent(pathname)));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': types[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(400).end('Bad request');
  }
});

server.listen(port, host, () => {
  const base = `http://${host}:${port}`;
  console.log(`Design system served from ${root}`);
  console.log(`  Gallery:    ${base}/gallery.html`);
  console.log(`  Prototype:  ${base}/prototype/agent-studio-prototype.dc.html?startSignedIn=true`);
  console.log('Ctrl+C to stop.');
});
