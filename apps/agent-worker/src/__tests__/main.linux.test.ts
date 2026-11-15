import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// Issue #96 (review of #112, finding 4): the worker process as it runs, its built main.js,
// against a stub of the worker routes: SIGTERM → stop() → the Run reported failed → exit 0,
// and the refusal to start with Studio-side settings. Linux only, like the worker.

const MAIN = join(import.meta.dirname, '..', '..', 'dist', 'main.js');
// A throwaway token generated per run; none is committed.
const TOKEN = randomBytes(32).toString('base64');
const RUN = {
  runId: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'codex',
  task: '[fake:slow] Take your time',
  startCommit: 'a'.repeat(40),
};

type Report = { path: string; body: Record<string, unknown> };

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}

/** The worker routes: one claimable Run, every report recorded; 401 without the token. */
async function stubStudio(): Promise<{ server: Server; url: string; reports: Report[] }> {
  const reports: Report[] = [];
  let claimed = false;
  const server = createServer((request, response) => {
    void readJson(request).then((body) => {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      const path = request.url ?? '';
      if (path === '/api/worker/runs/claim') {
        if (claimed) {
          response.writeHead(204).end();
          return;
        }
        claimed = true;
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(RUN));
        return;
      }
      reports.push({ path, body });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}`, reports };
}

function startWorker(env: Record<string, string>) {
  // A clean environment: nothing of the test runner's leaks in.
  const child = spawn(process.execPath, [MAIN], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { child, exited, stderr: () => stderr };
}

describe.skipIf(process.platform !== 'linux')('agent worker process (main.js)', () => {
  let stub: Awaited<ReturnType<typeof stubStudio>>;
  let child: ChildProcess | undefined;

  beforeAll(() => {
    if (!existsSync(MAIN)) {
      throw new Error(
        'Build the worker first (pnpm test:agent-worker does): dist/main.js is missing.',
      );
    }
  });

  afterEach(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    child = undefined;
    await new Promise((resolve) => stub?.server.close(resolve));
  });

  it('on SIGTERM reports the Run it carries as failed with worker_lost and exits 0', async () => {
    stub = await stubStudio();
    const worker = startWorker({
      STUDIO_API_URL: stub.url,
      STUDIO_WORKER_TOKEN: TOKEN,
      STUDIO_WORKER_POLL_MS: '100',
      STUDIO_WORKER_HEARTBEAT_MS: '200',
    });
    child = worker.child;
    const deadline = Date.now() + 15_000;
    while (!stub.reports.some((report) => report.body.state === 'running')) {
      if (Date.now() > deadline) throw new Error(`no running report; stderr: ${worker.stderr()}`);
      await delay(50);
    }

    worker.child.kill('SIGTERM');

    expect(await worker.exited).toBe(0);
    const states = stub.reports
      .filter((report) => report.path === `/api/worker/runs/${RUN.runId}/state`)
      .map((report) => report.body);
    expect(states.at(-1)).toEqual({
      workerId: expect.any(String),
      state: 'failed',
      failure: { code: 'worker_lost', detail: 'worker shut down' },
    });
  });

  it('refuses to start with a Studio-side setting, naming it but not its value', async () => {
    stub = await stubStudio();
    const secret = `secret-${randomBytes(8).toString('hex')}`;
    const worker = startWorker({
      STUDIO_API_URL: stub.url,
      STUDIO_WORKER_TOKEN: TOKEN,
      DATABASE_URL: `postgresql://studio:${secret}@localhost:5432/studio`,
    });
    child = worker.child;

    expect(await worker.exited).toBe(1);
    expect(worker.stderr()).toContain('DATABASE_URL: is a Studio-side setting');
    expect(worker.stderr()).not.toContain(secret);
    expect(stub.reports).toEqual([]);
  });
});
