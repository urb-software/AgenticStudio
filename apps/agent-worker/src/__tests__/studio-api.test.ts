import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StudioApi, StudioApiError } from '../studio-api.js';

// Issue #96: the worker's client of the worker routes, against a stubbed fetch.
const TOKEN = randomBytes(32).toString('base64');
const WORKER_ID = '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d';

type Call = { url: string; init: RequestInit };

function client(answer: (call: Call) => Promise<Response>, timeoutMs = 1000) {
  const calls: Call[] = [];
  const api = new StudioApi({
    apiUrl: 'http://studio.test',
    token: TOKEN,
    workerId: WORKER_ID,
    timeoutMs,
    fetch: ((url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return answer(call);
    }) as typeof fetch,
  });
  return { api, calls };
}

/** A fetch that never answers, but rejects with the signal's reason when it aborts. */
const hanging = ({ init }: Call) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

describe('StudioApi', () => {
  it('asks for the states of Runs and validates the answer (Issue #98)', async () => {
    const runId = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
    const answer = [{ runId, state: 'succeeded', finishedAt: '2026-11-15T10:00:00.000Z' }];
    const { api, calls } = client(async () => Response.json(answer));

    expect(await api.runStates([runId])).toEqual(answer);

    expect(calls[0]?.url).toBe('http://studio.test/api/worker/runs/states');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      workerId: WORKER_ID,
      runIds: [runId],
    });
    const { api: invalid } = client(async () => Response.json([{ runId, state: 'gone' }]));
    await expect(invalid.runStates([runId])).rejects.toThrow();
  });

  it('sends the token as a Bearer credential and the worker id in the JSON body', async () => {
    const { api, calls } = client(async () => new Response(null, { status: 204 }));

    expect(await api.claim()).toBeNull();

    expect(calls[0]?.url).toBe('http://studio.test/api/worker/runs/claim');
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ workerId: WORKER_ID });
  });

  it('reports the status to /api/worker/status with the worker id (Issue #101)', async () => {
    const { api, calls } = client(async () => new Response(null, { status: 204 }));

    await api.reportStatus({ runner: 'cli', providers: { claude_code: true, codex: false } });

    expect(calls[0]?.url).toBe('http://studio.test/api/worker/status');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      workerId: WORKER_ID,
      runner: 'cli',
      providers: { claude_code: true, codex: false },
    });
  });

  it('turns an error status into a StudioApiError with the problem type, without the token', async () => {
    const { api } = client(
      async () =>
        new Response(JSON.stringify({ type: 'urn:agentic-studio:problem:run-not-held' }), {
          status: 409,
        }),
    );

    const error = await api.heartbeat('run-1').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StudioApiError);
    expect(error).toMatchObject({
      status: 409,
      problemType: 'urn:agentic-studio:problem:run-not-held',
    });
    expect(String((error as Error).message)).not.toContain(TOKEN);
  });

  it('abandons a call that gets no answer within the timeout (review of #112)', async () => {
    const { api } = client(hanging, 50);
    const started = Date.now();

    await expect(api.claim()).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('abandons a call at once when the caller aborts (the worker stops)', async () => {
    const { api } = client(hanging, 60_000);
    const stop = new AbortController();

    const pending = api.reportState('run-1', { state: 'running' }, stop.signal);
    stop.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
