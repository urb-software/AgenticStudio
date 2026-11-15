import type { RunPayload, RunStepResult, WorkingCopyReport } from '@agentic-studio/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRunner } from '../fake-runner.js';
import type { Runner, RunStep, StartRunStepInput } from '../runner.js';
import { StudioApiError } from '../studio-api.js';
import { AgentWorker, SHUTDOWN_FAILURE, type WorkerApi } from '../worker.js';
import { PreparationFailedError, type PreparedRun, type WorkingCopyPort } from '../working-copy.js';

// Issue #96: the worker loop against a recording fake of the worker routes.
const payload = (task: string, n = 1): RunPayload => ({
  runId: `0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1${n}`,
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'codex',
  task,
  startCommit: 'a'.repeat(40),
  repository: { remoteUrl: 'https://git.example.test/acme/shop.git' },
});

const REPORT: WorkingCopyReport = {
  runBranch: 'agent/add-a-feature-r0b8e5c2d',
  commits: [{ id: 'c'.repeat(40), subject: 'Add a feature' }],
  hasUncommittedChanges: true,
};

/** Issue #98: a recording fake of the Working copies (the real one: working-copy.linux.test.ts). */
class FakeWorkingCopies implements WorkingCopyPort {
  readonly prepared: string[] = [];
  readonly reported: string[] = [];
  failure: Error | undefined;
  /** Called when preparation starts; the test can look at what was reported before it. */
  onPrepare: (() => void) | undefined;

  async prepare(run: RunPayload): Promise<PreparedRun> {
    this.onPrepare?.();
    this.prepared.push(run.runId);
    if (this.failure) throw this.failure;
    return {
      runId: run.runId,
      runDir: `/data/runs/${run.runId}`,
      repoDir: `/data/runs/${run.runId}/repo`,
      runBranch: REPORT.runBranch,
      startCommit: run.startCommit,
      env: { COMPOSE_PROJECT_NAME: 'studio-run-0b8e5c2d1f3a' },
    };
  }

  /** When set, reading the Working copy fails. */
  reportFailure: Error | undefined;

  async report(prepared: PreparedRun): Promise<WorkingCopyReport> {
    this.reported.push(prepared.runId);
    if (this.reportFailure) throw this.reportFailure;
    return REPORT;
  }
}

class RecordingApi implements WorkerApi {
  readonly calls: [string, string, unknown?][] = [];
  claims = 0;
  heartbeatError: Error | undefined;
  claimError: Error | undefined;
  /** When set, claims hang until their signal aborts (an API that does not answer). */
  claimHangs = false;

  constructor(private readonly queue: RunPayload[]) {}

  async claim(signal?: AbortSignal) {
    this.claims++;
    if (this.claimHangs) {
      return new Promise<null>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    }
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

function startWorker(
  api: RecordingApi,
  runner: Runner = new FakeRunner({ slowMs: 60_000 }),
  workingCopies: WorkingCopyPort = new FakeWorkingCopies(),
) {
  worker = new AgentWorker({
    api,
    runner,
    workingCopies,
    pollMs: 5,
    heartbeatMs: 10,
    logger: silent,
  });
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
      [
        'step',
        run.runId,
        {
          kind: 'start',
          result: expect.objectContaining({ outcome: 'done' }),
          workingCopy: REPORT,
        },
      ],
      ['state', run.runId, { state: 'succeeded' }],
    ]);
  });

  it('prepares the Working copy while preparing, before it reports running (Issue #98)', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    const workingCopies = new FakeWorkingCopies();
    let reportsBeforePreparation: unknown[] | undefined;
    workingCopies.onPrepare = () => (reportsBeforePreparation = [...api.reports()]);
    startWorker(api, undefined, workingCopies);

    await until(() => api.reports().length === 3);

    expect(reportsBeforePreparation).toEqual([]);
    expect(workingCopies.prepared).toEqual([run.runId]);
    expect(workingCopies.reported).toEqual([run.runId]);
  });

  it('runs the step in the Working copy with the Run step environment (Issue #98)', async () => {
    const inputs: StartRunStepInput[] = [];
    const recording: Runner = {
      // eslint-disable-next-line require-yield
      async *start(input): RunStep {
        inputs.push(input);
        return { outcome: 'done', summary: 'Done.' };
      },
      resume: () => {
        throw new Error('not used');
      },
    };
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    startWorker(api, recording);

    await until(() => api.reports().length === 3);

    expect(inputs[0]?.workspace).toEqual({
      repoDir: `/data/runs/${run.runId}/repo`,
      runDir: `/data/runs/${run.runId}`,
      env: { COMPOSE_PROJECT_NAME: 'studio-run-0b8e5c2d1f3a' },
    });
  });

  it('fails the Run with preparation_failed and its detail, starting no Run step (Issue #98)', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    const workingCopies = new FakeWorkingCopies();
    workingCopies.failure = new PreparationFailedError('The start commit is missing.');
    let started = false;
    const runner: Runner = {
      // eslint-disable-next-line require-yield
      async *start(): RunStep {
        started = true;
        return { outcome: 'done', summary: '' };
      },
      resume: () => {
        throw new Error('not used');
      },
    };
    startWorker(api, runner, workingCopies);

    await until(() => api.reports().length === 1);

    expect(api.reports()).toEqual([
      [
        'state',
        run.runId,
        {
          state: 'failed',
          failure: { code: 'preparation_failed', detail: 'The start commit is missing.' },
        },
      ],
    ]);
    expect(started).toBe(false);
  });

  it("sends a crashed step's Working copy state with the failure (Issue #98)", async () => {
    const run = payload('[fake:crash]');
    const api = new RecordingApi([run]);
    startWorker(api);

    await until(() => api.reports().length === 2);

    expect(api.reports()[1]?.[2]).toMatchObject({
      state: 'failed',
      failure: { code: 'unknown' },
      workingCopy: REPORT,
    });
  });

  it('still reports the failure when the Working copy cannot be read', async () => {
    const run = payload('[fake:fail]');
    const api = new RecordingApi([run]);
    const workingCopies = new FakeWorkingCopies();
    workingCopies.reportFailure = new Error('git status failed');
    startWorker(api, undefined, workingCopies);

    await until(() => api.reports().length === 2);

    expect(api.reports()[1]?.[2]).toEqual({
      state: 'failed',
      failure: { code: 'agent_failed', detail: 'The fake agent failed.' },
    });
  });

  it('reports an unexpected preparation error as unknown, without its text', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    const workingCopies = new FakeWorkingCopies();
    workingCopies.failure = new Error('EACCES: /secret/path');
    startWorker(api, undefined, workingCopies);

    await until(() => api.reports().length === 1);

    expect(api.reports()[0]?.[2]).toMatchObject({ state: 'failed', failure: { code: 'unknown' } });
    expect(JSON.stringify(api.reports())).not.toContain('/secret/path');
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
      {
        state: 'failed',
        failure: { code: 'agent_failed', detail: 'The fake agent failed.' },
        // Coordinator decision on #98: what the failed step left in the Working copy.
        workingCopy: REPORT,
      },
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

  it('on stop abandons a call in flight instead of waiting for the API (review of #112)', async () => {
    const api = new RecordingApi([]);
    api.claimHangs = true;
    const running = startWorker(api);
    await until(() => api.claims === 1);

    const started = Date.now();
    await running.stop();

    expect(Date.now() - started).toBeLessThan(1000);
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
      ['state', run.runId, { state: 'failed', failure: SHUTDOWN_FAILURE, workingCopy: REPORT }],
    ]);
    expect(SHUTDOWN_FAILURE).toEqual({ code: 'worker_lost', detail: 'worker shut down' });
    const claims = api.claims;
    await delay(30);
    expect(api.claims).toBe(claims);
  });
});
