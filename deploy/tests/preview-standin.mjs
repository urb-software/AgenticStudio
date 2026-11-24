// A stand-in for the Preview bridges (#285), for deploy/tests/preview-proxy.test.mjs. Node core only.
//
//   node preview-standin.mjs <socket directory>
//
// It listens on one Unix socket per label, named `<label>.sock` in the directory, and answers
// every HTTP request with the request's headers as JSON (plus its label), and every WebSocket
// upgrade with the handshake, the headers as the first text frame, and then an echo of every
// text frame. Control lines on stdin, one reply line on stdout each:
//
//   up <label>     start listening (sockets are made with mode 0660)
//   down <label>   stop listening; the socket file goes with it
//   stale <label>  leave a socket file nobody listens on (a bridge that was killed)
//   quit
//
// Every request also prints `hit <label>` first, so the test can count what reached it.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Sockets get 0660 at once (the proxy's group needs write access to connect).
process.umask(0o007);

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** One unmasked server text frame. */
function textFrame(text) {
  const payload = Buffer.from(text);
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x81, length])
      : length < 65536
        ? Buffer.from([0x81, 126, length >> 8, length & 255])
        : null;
  if (!header) throw new Error('frame too large for the stand-in');
  return Buffer.concat([header, payload]);
}

/** Reads masked client text frames from a buffer; returns the texts and the unread rest. */
function readFrames(buffer) {
  const texts = [];
  let close = false;
  for (;;) {
    if (buffer.length < 2) break;
    const opcode = buffer[0] & 0x0f;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) break;
      length = buffer.readUInt16BE(2);
      offset = 4;
    }
    const masked = (buffer[1] & 0x80) !== 0;
    const end = offset + (masked ? 4 : 0) + length;
    if (buffer.length < end) break;
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    const data = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), end));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    buffer = buffer.subarray(end);
    if (opcode === 0x8) close = true;
    else if (opcode === 0x1) texts.push(data.toString('utf8'));
  }
  return { texts, close, rest: buffer };
}

function makeServer(label) {
  const echo = (request) =>
    JSON.stringify({
      label,
      method: request.method,
      url: request.url,
      httpVersion: request.httpVersion,
      headers: request.headers,
    });
  const server = createServer((request, response) => {
    console.log(`hit ${label}`);
    response.writeHead(200, { 'Content-Type': 'application/json', 'X-Preview-Label': label });
    response.end(echo(request));
  });
  server.on('upgrade', (request, socket, head) => {
    console.log(`hit ${label}`);
    const accept = createHash('sha1')
      .update(String(request.headers['sec-websocket-key']) + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.write(textFrame(echo(request)));
    let pending = head;
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const { texts, close, rest } = readFrames(pending);
      pending = rest;
      for (const text of texts) socket.write(textFrame(`echo:${text}`));
      if (close) socket.end(Buffer.from([0x88, 0x00]));
    });
    socket.on('error', () => {});
  });
  return server;
}

if (process.argv[2] === '--child') {
  // A bridge that is killed leaves its socket file behind: the parent kills this process.
  const server = makeServer('stale');
  server.listen(process.argv[3], () => console.log('ready'));
} else {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node preview-standin.mjs <socket directory>');
  const servers = new Map();
  const socketPath = (label) => join(dir, `${label}.sock`);

  const up = (label) =>
    new Promise((resolve, reject) => {
      if (servers.has(label)) return resolve();
      rmSync(socketPath(label), { force: true });
      const server = makeServer(label);
      server.once('error', reject);
      server.listen(socketPath(label), async () => {
        await chmod(socketPath(label), 0o660);
        servers.set(label, server);
        resolve();
      });
    });
  const down = (label) =>
    new Promise((resolve) => {
      const server = servers.get(label);
      servers.delete(label);
      if (!server) return resolve();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  const stale = (label) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), '--child', socketPath(label)],
        {
          stdio: ['ignore', 'pipe', 'inherit'],
        },
      );
      child.once('error', reject);
      child.stdout.once('data', () => {
        child.kill('SIGKILL');
        child.once('exit', () => resolve());
      });
    });

  const commands = { up, down, stale };
  const lines = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  lines.on('line', (line) => {
    queue = queue.then(async () => {
      const [command, label] = line.trim().split(/\s+/);
      if (command === 'quit') {
        for (const name of [...servers.keys()]) await down(name);
        console.log('ok quit');
        process.exit(0);
      }
      try {
        if (!commands[command] || !/^[a-z0-9-]+$/.test(label ?? '')) throw new Error('bad command');
        await commands[command](label);
        console.log(`ok ${command} ${label}`);
      } catch (error) {
        console.log(`error ${command} ${label} ${error.message}`);
      }
    });
  });
  lines.on('close', () => {
    for (const label of servers.keys()) rmSync(socketPath(label), { force: true });
    process.exit(0);
  });
}
