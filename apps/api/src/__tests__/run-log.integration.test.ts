import { createHash, createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE_CLIENT, type DatabaseClient } from '../platform/database/database.module.js';
import { problemDetailsSchema } from '../platform/http/problem-details.js';
import {
  signIn,
  startStudioApp,
  startStudioServices,
  STUDIO_ORIGIN,
  type StudioServices,
} from './studio-test-app.js';

// Issue #99, main seam: a Run's log over HTTP on the real app with PostgreSQL and Redis from
// Testcontainers. The worker appends over its route exactly as the agent worker does; the
// operator reads the stored log in pages and live as server-sent events.

// Throwaway values generated per run; none is committed.
const WORKER_TOKEN = randomBytes(32).toString('base64');
const WORKER_TOKEN_DIGEST = createSecretKey(createHash('sha256').update(WORKER_TOKEN).digest());
/** A small per-Run cap (above one full 16 KiB event), so the cap test needs few events. */
const LOG_MAX_BYTES = 40_000;
/** A known secret value of every Run in this suite (the #104 hook, through the test seam). */
const KNOWN_SECRET = `env-value-${randomBytes(6).toString('hex')}`;
const REDACTED = '••••••[redacted]';
const RUN_NOT_HELD = 'urn:agentic-studio:problem:run-not-held';
const RUN_NOT_FOUND = 'urn:agentic-studio:problem:run-not-found';

type SentEvent = { seq: number; stepIndex: number; kind: string; text: string };

function expectProblem(response: request.Response, status: number, type?: string) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(problemDetailsSchema.safeParse(response.body).success).toBe(true);
  if (type) expect(response.body.type).toBe(type);
}

/** The `id` and parsed `data` of each message of a text/event-stream body; comments apart. */
function parseStream(body: string) {
  const messages = body
    .split('\n\n')
    .filter((block) => block.includes('data: ') && !block.startsWith('event: end'))
    .map((block) => {
      const id = /^id: (\d+)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      return { id: Number(id), event: JSON.parse(data!) as SentEvent & { truncated?: true } };
    });
  return {
    messages,
    keepAlives: body.split('\n\n').filter((b) => b === ': keep-alive').length,
    ended: body.endsWith('event: end\ndata: {}\n\n'),
  };
}

describe('Run log API (PostgreSQL + Redis via Testcontainers)', () => {
  let services: StudioServices;
  let app: INestApplication;
  let cookie: string;
  let baseUrl: string;

  const db = () => app.get<DatabaseClient>(DATABASE_CLIENT);
  const http = () => request(app.getHttpServer());
  const W1 = randomUUID();
  const W2 = randomUUID();

  const worker = (path: string, body: object, token: string | null = WORKER_TOKEN) => {
    const call = http().post(`/api/worker/runs/${path}`);
    if (token !== null) call.set('Authorization', `Bearer ${token}`);
    return call.send(body);
  };
  const event = (seq: number, overrides: Partial<SentEvent> = {}) => ({
    seq,
    at: '2026-11-15T12:00:00.000Z',
    stepIndex: 1,
    kind: 'output',
    text: `line ${seq}`,
    ...overrides,
  });
  const append = (runId: string, events: object[], workerId = W1, token?: string | null) =>
    worker(`${runId}/events`, { workerId, events }, token);
  const page = (runId: string, query = '') =>
    http().get(`/api/runs/${runId}/events${query}`).set('Cookie', cookie);
  const streamBody = (runId: string, query = '', headers: Record<string, string> = {}) =>
    http()
      .get(`/api/runs/${runId}/events/stream${query}`)
      .set({ Cookie: cookie, ...headers })
      .buffer(true)
      .parse((response, done) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => done(null, text));
      });

  /** A Run claimed by W1 and running (test setup: a project with a ready Repository). */
  async function runningRun(): Promise<string> {
    const name = `Project ${randomUUID()}`;
    const [project] = await db().$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    const path = `git.example.test/acme/${project!.id}`;
    await db().$executeRaw`
      INSERT INTO repositories
        (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at)
      VALUES (${project!.id}::uuid, ${`https://${path}.git`}, ${path}, 'dev', 'ready',
              ${randomBytes(20).toString('hex')}, now())`;
    const started = await http()
      .post(`/api/projects/${project!.id}/runs`)
      .set({ Origin: STUDIO_ORIGIN, Cookie: cookie })
      .send({ task: 'Add a health check', provider: 'codex' });
    expect(started.status).toBe(201);
    expect((await worker('claim', { workerId: W1 })).body.runId).toBe(started.body.id);
    expect(
      (await worker(`${started.body.id}/state`, { workerId: W1, state: 'running' })).status,
    ).toBe(204);
    return started.body.id as string;
  }
  const finish = async (runId: string) =>
    expect((await worker(`${runId}/state`, { workerId: W1, state: 'succeeded' })).status).toBe(204);

  beforeAll(async () => {
    services = await startStudioServices();
    app = await startStudioApp(
      { ...services.config, workerToken: WORKER_TOKEN_DIGEST, runLogMaxBytes: LOG_MAX_BYTES },
      {
        executions: {
          logKeepAliveMs: 200,
          secretValues: { forRun: () => Promise.resolve([KNOWN_SECRET]) },
        },
      },
    );
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    cookie = await signIn(app);
  });

  afterAll(async () => {
    await app?.close();
    await services?.stop();
  });

  beforeEach(async () => {
    // Test isolation only; CASCADE also empties runs, run_steps and run_events.
    await db().$executeRaw`TRUNCATE TABLE projects CASCADE`;
  });

  describe('appending and paging', () => {
    it('stores events in sequence order and reads them back in pages', async () => {
      const runId = await runningRun();
      const sent = [
        event(1, { kind: 'step_started', text: 'Run step 1 started' }),
        event(2, { kind: 'message', text: 'I will add GET /health.' }),
        event(3, { kind: 'command', text: 'pnpm test' }),
        event(4, { text: '12 tests passed' }),
        event(5, { kind: 'step_finished', text: 'Run step 1 finished: done' }),
      ];

      expect((await append(runId, sent.slice(0, 3))).status).toBe(204);
      expect((await append(runId, sent.slice(3))).status).toBe(204);

      const first = await page(runId, '?limit=2');
      expect(first.status).toBe(200);
      expect(first.body).toEqual({
        events: [
          { ...sent[0], at: '2026-11-15T12:00:00.000Z' },
          { ...sent[1], at: '2026-11-15T12:00:00.000Z' },
        ],
        next: 2,
      });
      const rest = await page(runId, `?after=${first.body.next}`);
      expect(rest.body.events.map((stored: SentEvent) => stored.seq)).toEqual([3, 4, 5]);
      expect(rest.body).not.toHaveProperty('next');
    });

    it('ignores a re-sent batch, so a retry neither loses nor duplicates events', async () => {
      const runId = await runningRun();

      await append(runId, [event(1), event(2)]);
      expect((await append(runId, [event(1), event(2), event(3)])).status).toBe(204);
      expect((await append(runId, [event(1), event(2), event(3)])).status).toBe(204);

      expect((await page(runId)).body.events.map((stored: SentEvent) => stored.seq)).toEqual([
        1, 2, 3,
      ]);
    });

    it('accepts a gap in the sequence and serves it as is, paged and streamed', async () => {
      const runId = await runningRun();

      await append(runId, [event(1), event(4)]);
      await append(runId, [event(9)]);
      await finish(runId);

      expect((await page(runId)).body.events.map((stored: SentEvent) => stored.seq)).toEqual([
        1, 4, 9,
      ]);
      const streamed = parseStream((await streamBody(runId, '?after=1')).body as string);
      expect(streamed.messages.map((message) => message.id)).toEqual([4, 9]);
    });

    it('stores one "log truncated" notice at the per-Run cap and keeps the Run going', async () => {
      const runId = await runningRun();
      const big = 'x'.repeat(15_000);

      await append(runId, [event(1, { text: big }), event(2, { text: big })]);
      await append(runId, [event(3, { text: big }), event(4, { text: 'after' })]);
      await append(runId, [event(5, { text: 'later' })]);
      // A re-send of the batch that hit the cap changes nothing: still one notice.
      await append(runId, [event(3, { text: big }), event(4, { text: 'after' })]);

      const events = (await page(runId)).body.events as SentEvent[];
      expect(events.map(({ seq, kind }) => ({ seq, kind }))).toEqual([
        { seq: 1, kind: 'output' },
        { seq: 2, kind: 'output' },
        { seq: 3, kind: 'notice' },
      ]);
      expect(events[2]!.text).toMatch(/^log truncated/);
      await finish(runId);
      expect((await http().get(`/api/runs/${runId}`).set('Cookie', cookie)).body.state).toBe(
        'succeeded',
      );
    });

    it('cuts an event over 16 KiB after redaction and marks it truncated', async () => {
      const runId = await runningRun();

      await append(runId, [event(1, { text: KNOWN_SECRET.repeat(800).slice(0, 16_384) })]);

      const [stored] = (await page(runId)).body.events;
      expect(stored.truncated).toBe(true);
      expect(Buffer.byteLength(stored.text)).toBeLessThanOrEqual(16 * 1024);
      expect(stored.text).not.toContain(KNOWN_SECRET);
    });

    it('redacts a known secret value and token-shaped strings before storing them', async () => {
      const runId = await runningRun();
      const token = `ghp_${randomBytes(18).toString('hex')}`;
      const url = 'https://agent:hunter2@git.example.test/acme/shop.git';

      await append(runId, [
        event(1, { kind: 'command', text: `curl -H "Authorization: Bearer ${token}" ${url}` }),
        event(2, { text: `PASSWORD=${KNOWN_SECRET}` }),
      ]);

      const texts = (await page(runId)).body.events.map((stored: SentEvent) => stored.text);
      expect(texts).toEqual([
        `curl -H "Authorization: ${REDACTED}" https://${REDACTED}@git.example.test/acme/shop.git`,
        `PASSWORD=${REDACTED}`,
      ]);
      // Checked in the table too: the secret never reached storage.
      const raw = await db().$queryRaw<{ text: string }[]>`
        SELECT text FROM run_events WHERE run_id = ${runId}::uuid`;
      expect(raw.map((row) => row.text).join('\n')).not.toMatch(
        new RegExp(`${KNOWN_SECRET}|${token}|hunter2`),
      );
    });

    it('validates the page query', async () => {
      const runId = await runningRun();

      expectProblem(await page(runId, '?limit=1001'), 400);
      expectProblem(await page(runId, '?limit=0'), 400);
      expectProblem(await page(runId, '?after=-1'), 400);
      expect((await page(runId, '?limit=1000')).status).toBe(200);
    });
  });

  describe('streaming', () => {
    it('streams new events live, then ends once the Run is final', async () => {
      const runId = await runningRun();
      await append(runId, [event(1)]);
      const response = await fetch(`${baseUrl}/api/runs/${runId}/events/stream`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
      expect(response.headers.get('cache-control')).toMatch(/no-cache/);
      expect(response.headers.get('x-accel-buffering')).toBe('no');
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let received = '';
      const readUntil = async (needle: string) => {
        while (!received.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value;
        }
      };

      await readUntil('"seq":1');
      // Appended while the stream is open: it arrives before the Run ends.
      await append(runId, [event(2, { text: 'live line' })]);
      await readUntil('live line');
      await readUntil(': keep-alive');
      await finish(runId);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value;
      }

      expect(parseStream(received).messages.map((message) => message.id)).toEqual([1, 2]);
      expect(parseStream(received).keepAlives).toBeGreaterThan(0);
      expect(parseStream(received).ended).toBe(true);
    });

    it('resumes after a seq, from the query or from Last-Event-ID, without repeats', async () => {
      const runId = await runningRun();
      await append(runId, [event(1), event(2), event(3)]);
      await finish(runId);

      const all = await streamBody(runId);
      expect(all.status).toBe(200);
      expect(parseStream(all.body as string).messages).toEqual([
        { id: 1, event: { ...event(1) } },
        { id: 2, event: { ...event(2) } },
        { id: 3, event: { ...event(3) } },
      ]);
      const afterQuery = await streamBody(runId, '?after=2');
      expect(parseStream(afterQuery.body as string).messages.map((m) => m.id)).toEqual([3]);
      const afterHeader = await streamBody(runId, '', { 'Last-Event-ID': '1' });
      expect(parseStream(afterHeader.body as string).messages.map((m) => m.id)).toEqual([2, 3]);
      // `after` wins over the header; a header the stream never sent counts as none.
      const both = await streamBody(runId, '?after=2', { 'Last-Event-ID': '1' });
      expect(parseStream(both.body as string).messages.map((m) => m.id)).toEqual([3]);
      for (const header of ['abc', '-1', '99999999999', '9999999999']) {
        const malformed = await streamBody(runId, '', { 'Last-Event-ID': header });
        expect(parseStream(malformed.body as string).messages.map((m) => m.id)).toEqual([1, 2, 3]);
      }
      // A completed stream ends with the `end` event, so the client does not reconnect.
      expect(parseStream(all.body as string).ended).toBe(true);
    });
  });

  describe('step results', () => {
    it("lists each Run step's structured result for the log", async () => {
      const runId = await runningRun();
      await worker(`${runId}/steps`, {
        workerId: W1,
        kind: 'start',
        result: {
          outcome: 'done',
          summary: 'Added GET /health.',
          checks: [{ name: 'unit tests', result: 'passed' }],
        },
      });

      const steps = await http().get(`/api/runs/${runId}/steps`).set('Cookie', cookie);

      expect(steps.status).toBe(200);
      expect(steps.body).toEqual({
        steps: [
          {
            index: 1,
            kind: 'start',
            outcome: 'done',
            summary: 'Added GET /health.',
            checks: [{ name: 'unit tests', result: 'passed' }],
            reportedAt: expect.any(String),
          },
        ],
      });
    });
  });

  describe('rejected requests', () => {
    it('requires the operator session to read the log, live or paged, and the steps', async () => {
      const runId = await runningRun();

      expectProblem(await http().get(`/api/runs/${runId}/events`), 401);
      expectProblem(await http().get(`/api/runs/${runId}/events/stream`), 401);
      expectProblem(await http().get(`/api/runs/${runId}/steps`), 401);
    });

    it('requires the worker token to append, and the session grants nothing there', async () => {
      const runId = await runningRun();

      expectProblem(await append(runId, [event(1)], W1, null), 401);
      expectProblem(await append(runId, [event(1)], W1, randomBytes(32).toString('base64')), 401);
      expectProblem(
        await http()
          .post(`/api/worker/runs/${runId}/events`)
          .set({ Cookie: cookie, Origin: STUDIO_ORIGIN })
          .send({ workerId: W1, events: [event(1)] }),
        401,
      );
      expect((await page(runId)).body.events).toEqual([]);
    });

    it('accepts events only from the worker holding the Run, and not after it is final', async () => {
      const runId = await runningRun();

      expectProblem(await append(runId, [event(1)], W2), 409, RUN_NOT_HELD);
      await finish(runId);
      expectProblem(await append(runId, [event(1)], W1), 409, RUN_NOT_HELD);
      expect((await page(runId)).body.events).toEqual([]);
    });

    it('answers 404 for an unknown Run and 400 for a malformed batch', async () => {
      const runId = await runningRun();

      expectProblem(await append(randomUUID(), [event(1)]), 404, RUN_NOT_FOUND);
      expectProblem(await page(randomUUID()), 404, RUN_NOT_FOUND);
      expectProblem(
        await http().get('/api/runs/nope/events/stream').set('Cookie', cookie),
        404,
        RUN_NOT_FOUND,
      );
      expectProblem(await append(runId, [event(2), event(1)]), 400);
      expectProblem(await append(runId, []), 400);
    });
  });
});
