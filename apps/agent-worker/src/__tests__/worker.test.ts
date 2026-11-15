import type { RunPayload, RunStepResult } from '@agentic-studio/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRunner } from '../fake-runner.js';
import type { Runner, RunStep } from '../runner.js';
import { StudioApiError } from '../studio-api.js';
import { AgentWorker, SHUTDOWN_FAILURE, type WorkerApi } from '../worker.js';

// Issue #96: the worker loop against a recording fake of the worker routes.
const payload = (task: string, n = 1): RunPayload => ({
  runId: `0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1${n}`,
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'codex',
  task,
  startCommit: 'a'.repeat(40),
});

class RecordingApi implements WorkerApi {
  readonly calls: [string, string, unknown?][] = [];
  claims = 0;
  heartbeatError: Error | undefined;
  claimError: Error | undefined;

  constructor(private readonly queue: RunPayload[]) {}

  async claim() {
    this.claims++;
    if (this.claimError) {
      const error = this.claimError;
      this.claimError = undefined;
      throw error;
    }
    return this.queue.shift() ?? null;
  }
  async reportState(runId: string, report: unknown) {
    this.calls.push(['state', runId, report]);
  }
  async reportStep(runId: string, step: unknown) {
    this.calls.push(['step', runId, step]);
  }
  async heartbeat(runId: string) {
    this.calls.push(['heartbeat', runId]);
    if (this.heartbeatError) throw this.heartbeatError;
  }
  reports() {
    return this.calls.filter(([kind]) => kind !== 'heartbeat');
  }
}

const silent = { info: () => undefined, error: () => undefined };
let worker: AgentWorker | undefined;

function startWorker(api: RecordingApi, runner: Runner = new FakeRunner({ slowMs: 60_000 })) {
  worker = new AgentWorker({ api, runner, pollMs: 5, heartbeatMs: 10, logger: silent });
  void worker.run();
  return worker;
}

async function until(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await delay(5);
  }
}

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
});

describe('AgentWorker', () => {
  it('carries a Run to succeeded: running, the step result, succeeded', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    startWorker(api);

    await until(() => api.reports().length === 3);

    expect(api.reports()).toEqual([
      ['state', run.runId, { state: 'running' }],
      ['step', run.runId, { kind: 'start', result: expect.objectContaining({ outcome: 'done' }) }],
      ['state', run.runId, { state: 'succeeded' }],
    ]);
  });

  it('reports waiting_for_operator after a question', async () => {
    const run = payload('[fake:question]');
    const api = new RecordingApi([run]);
    startWorker(api);

    await until(() => api.reports().length === 3);

    expect(api.reports()[1]?.[2]).toMatchObject({ result: { outcome: 'needs_input' } });
    expect(api.reports()[2]).toEqual(['state', run.runId, { state: 'waiting_for_operator' }]);
  });

  it('reports an agent failure as agent_failed', async () => {
    const run = payload('[fake:fail]');
    const api = new RecordingApi([run]);
    startWorker(api);

    await until(() => api.reports().length === 2);

    expect(api.reports()[1]).toEqual([
      'state',
      run.runId,
      { state: 'failed', failure: { code: 'agent_failed', detail: 'The fake agent failed.' } },
    ]);
  });

  it('reports a runner crash as unknown, without the error text', async () => {
    const run = payload('[fake:crash]');
    const api = new RecordingApi([run]);
    startWorker(api);

    await until(() => api.reports().length === 2);

    expect(api.reports()[1]?.[2]).toMatchObject({ state: 'failed', failure: { code: 'unknown' } });
    expect(JSON.stringify(api.reports()[1])).not.toContain('crashed');
  });

  it('refuses an invalid structured result as agent_failed', async () => {
    const invalid: Runner = {
      // eslint-disable-next-line require-yield
      async *start(): RunStep {
        return { outcome: 'needs_input', summary: 'no question' } as RunStepResult;
      },
      resume: () => {
        throw new Error('not used');
      },
    };
    const run = payload('x');
    const api = new RecordingApi([run]);
    startWorker(api, invalid);

    await until(() => api.reports().length === 2);

    expect(api.reports()[1]?.[2]).toMatchObject({ failure: { code: 'agent_failed' } });
  });

  it('sends heartbeats while it carries a Run', async () => {
    const run = payload('[fake:slow]');
    const api = new RecordingApi([run]);
    startWorker(api);

    await until(() => api.calls.filter(([kind]) => kind === 'heartbeat').length >= 3);
  });

  it('drops a Run the API says it no longer holds, without reporting it', async () => {
    const run = payload('[fake:slow]');
    const api = new RecordingApi([run]);
    api.heartbeatError = new StudioApiError(409, '/api/worker/runs/x/heartbeat');
    startWorker(api);

    await until(() => api.claims >= 2);

    expect(api.reports()).toEqual([['state', run.runId, { state: 'running' }]]);
  });

  it('keeps polling after the API was unreachable', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    api.claimError = new TypeError('fetch failed');
    startWorker(api);

    await until(() => api.reports().length === 3);
  });

  it('on stop: stops polling, aborts the runner and reports the Run failed with worker_lost', async () => {
    const run = payload('[fake:slow]');
    const api = new RecordingApi([run, payload('second', 2)]);
    const running = startWorker(api);
    await until(() => api.reports().length === 1);

    await running.stop();

    expect(api.reports()).toEqual([
      ['state', run.runId, { state: 'running' }],
      ['state', run.runId, { state: 'failed', failure: SHUTDOWN_FAILURE }],
    ]);
    expect(SHUTDOWN_FAILURE).toEqual({ code: 'worker_lost', detail: 'worker shut down' });
    const claims = api.claims;
    await delay(30);
    expect(api.claims).toBe(claims);
  });
});
