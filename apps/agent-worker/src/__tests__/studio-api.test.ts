import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isRunLost, isTransient, StudioApi, StudioApiError } from '../studio-api.js';

// The worker's client of the worker routes, against a stubbed fetch.
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
  it('asks for the states of Runs and validates the answer', async () => {
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

  it('fetches the agent folder of a Run with a GET that carries only the worker id', async () => {
    const runId = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
    const answer = {
      commit: 'a'.repeat(40),
      files: [{ path: 'scripts/run.sh', executable: true, contentBase64: 'IyEvYmluL3NoCg==' }],
    };
    const { api, calls } = client(async () => Response.json(answer));

    expect(await api.agentFolder(runId)).toEqual(answer);

    expect(calls[0]?.url).toBe(
      `http://studio.test/api/worker/runs/${runId}/agent-folder?workerId=${WORKER_ID}`,
    );
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.body).toBeUndefined();
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    const { api: invalid } = client(async () =>
      Response.json({ commit: null, files: [{ path: 'a', executable: false, contentBase64: '' }] }),
    );
    await expect(invalid.agentFolder(runId)).rejects.toThrow();
  });

  it('keeps the problem type of a refused agent folder', async () => {
    const runId = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
    const { api } = client(async () =>
      Response.json(
        { type: 'urn:agentic-studio:problem:agent-folder-unavailable' },
        { status: 409 },
      ),
    );

    await expect(api.agentFolder(runId)).rejects.toMatchObject({
      status: 409,
      problemType: 'urn:agentic-studio:problem:agent-folder-unavailable',
    });
  });

  it('asks for the skills of a Run by its id and the worker id only, and validates the answer', async () => {
    const runId = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
    const answer = {
      commit: 'a'.repeat(40),
      skills: [
        {
          name: 'lint',
          files: [{ path: 'SKILL.md', executable: false, contentBase64: 'IyBTCg==' }],
        },
      ],
      omitted: ['big'],
    };
    const { api, calls } = client(async () => Response.json(answer));

    expect(await api.runSkills(runId)).toEqual(answer);

    expect(calls[0]?.url).toBe(
      `http://studio.test/api/worker/runs/${runId}/skills?workerId=${WORKER_ID}`,
    );
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.body).toBeUndefined();
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    const { api: invalid } = client(async () =>
      Response.json({ commit: null, skills: [{ name: 'lint', files: [] }], omitted: [] }),
    );
    await expect(invalid.runSkills(runId)).rejects.toThrow();
  });

  it('keeps the problem type of a refusal of the skills', async () => {
    const runId = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
    const { api } = client(async () =>
      Response.json({ type: 'urn:agentic-studio:problem:skills-invalid' }, { status: 409 }),
    );

    await expect(api.runSkills(runId)).rejects.toMatchObject({
      status: 409,
      problemType: 'urn:agentic-studio:problem:skills-invalid',
    });
  });

  it('reports removed Working copies with a states request', async () => {
    const runId = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
    const { api, calls } = client(async () => Response.json([]));

    await api.runStates([runId], undefined, [runId]);
    await api.runStates([runId], undefined, []);

    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      workerId: WORKER_ID,
      runIds: [runId],
      removedRunIds: [runId],
    });
    expect(JSON.parse(String(calls[1]?.init.body))).not.toHaveProperty('removedRunIds');
  });

  it('claims lookups (204: none) and validates what it is handed', async () => {
    const lookup = {
      id: 'c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f',
      kind: 'pull_request_state',
      runId: '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b',
      repository: { remoteUrl: 'https://github.com/acme/shop.git' },
      pullRequestNumber: 7,
      runBranch: 'agent/add-r0b8e5c2d',
      integrationBranch: 'dev',
    };
    const { api, calls } = client(async () => Response.json([lookup]));

    expect(await api.claimLookups()).toEqual([lookup]);
    expect(calls[0]?.url).toBe('http://studio.test/api/worker/lookups/claim');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ workerId: WORKER_ID });
    const { api: none } = client(async () => new Response(null, { status: 204 }));
    expect(await none.claimLookups()).toEqual([]);
    const { api: invalid } = client(async () => Response.json([{ ...lookup, kind: 'checks' }]));
    await expect(invalid.claimLookups()).rejects.toThrow();
  });

  it('reports a lookup result with the worker id and the lookup in the path', async () => {
    const { api, calls } = client(async () => new Response(null, { status: 204 }));

    await api.reportLookup('c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f', {
      ok: true,
      kind: 'pull_request_state',
      result: { state: 'merged' },
    });

    expect(calls[0]?.url).toBe(
      'http://studio.test/api/worker/lookups/c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f/result',
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      workerId: WORKER_ID,
      ok: true,
      kind: 'pull_request_state',
      result: { state: 'merged' },
    });
    const { api: refused } = client(async () =>
      Response.json({ type: 'urn:agentic-studio:problem:lookup-not-held' }, { status: 409 }),
    );
    await expect(
      refused.reportLookup('c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f', {
        ok: false,
        code: 'failed',
        error: 'x',
      }),
    ).rejects.toMatchObject({ status: 409 });
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

  it('reports the status to /api/worker/status with the worker id', async () => {
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

  it('abandons a call that gets no answer within the timeout', async () => {
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

  it('reads whether the operator asked to cancel from the heartbeat answer', async () => {
    const { api, calls } = client(async () => Response.json({ cancelRequested: true }));

    expect(await api.heartbeat('0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b')).toEqual({
      cancelRequested: true,
    });
    expect(calls[0]?.url).toBe(
      'http://studio.test/api/worker/runs/0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b/heartbeat',
    );
    const { api: invalid } = client(async () => Response.json({ cancel: 'yes' }));
    await expect(invalid.heartbeat('run-1')).rejects.toThrow();
  });

  it('tells a transient failure (Studio unreachable or failing) from a definitive answer', async () => {
    const { api: down } = client(async () => {
      throw new TypeError('fetch failed');
    });
    expect(isTransient(await down.heartbeat('run-1').catch((caught: unknown) => caught))).toBe(
      true,
    );
    const { api: slow } = client(hanging, 20);
    expect(isTransient(await slow.heartbeat('run-1').catch((caught: unknown) => caught))).toBe(
      true,
    );
    expect(isTransient(new StudioApiError(503, '/api/worker/runs/x/state'))).toBe(true);
    expect(isTransient(new StudioApiError(502, '/api/worker/runs/x/state'))).toBe(true);
    expect(isTransient(new StudioApiError(409, '/api/worker/runs/x/state'))).toBe(false);
    expect(isTransient(new StudioApiError(404, '/api/worker/runs/x/state'))).toBe(false);
    expect(isTransient(new StudioApiError(422, '/api/worker/runs/x/state'))).toBe(false);
    expect(isTransient(new StudioApiError(401, '/api/worker/runs/x/state'))).toBe(false);
  });

  // Only "not held" (and a failed Run) means the Run is lost, by problem type.
  it('tells a lost Run from a refused report by the problem type, not the status', () => {
    const path = '/api/worker/runs/x/state';
    expect(
      isRunLost(new StudioApiError(409, path, 'urn:agentic-studio:problem:run-not-held')),
    ).toBe(true);
    expect(
      isRunLost(new StudioApiError(409, path, 'urn:agentic-studio:problem:step-limit-reached')),
    ).toBe(true);
    expect(isRunLost(new StudioApiError(404, path))).toBe(true);
    expect(
      isRunLost(new StudioApiError(409, path, 'urn:agentic-studio:problem:illegal-run-transition')),
    ).toBe(false);
    expect(isRunLost(new StudioApiError(409, path))).toBe(false);
    expect(isRunLost(new TypeError('fetch failed'))).toBe(false);
  });
});
