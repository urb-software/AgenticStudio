import type {
  RunDelivery,
  RunEventInput,
  RunPayload,
  RunStepResult,
  WorkingCopyReport,
} from '@agentic-studio/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { DeliveryFailedError, type DeliveryPort } from '../delivery.js';
import { FakeRunner } from '../fake-runner.js';
import type { Runner, RunStep, StartRunStepInput } from '../runner.js';
import { ProviderDisabledError } from '../provider-gate.js';
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
  limits: { stepMinutes: 60, maxSteps: 10 },
  completedSteps: 0,
  integrationBranch: 'dev',
  kind: 'start',
  studioPaths: [],
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

const DELIVERED: RunDelivery = {
  outcome: 'delivered',
  pullRequest: { url: 'https://github.com/acme/shop/pull/7', number: 7 },
};

/** Issue #102: a recording fake of the delivery (the real one: delivery.linux.test.ts). */
class FakeDeliveries implements DeliveryPort {
  readonly calls: [string, string][] = [];
  delivery: RunDelivery = DELIVERED;
  commitFailure: Error | undefined;
  deliverFailure: Error | undefined;
  locateFailure: Error | undefined;
  /** Called on every step, so a test can see what was reported before it. */
  onCall: ((step: string) => void) | undefined;

  async commit(_prepared: PreparedRun, _run: RunPayload, result: RunStepResult) {
    this.calls.push(['commit', result.summary]);
    this.onCall?.('commit');
    if (this.commitFailure) throw this.commitFailure;
  }
  /** When set, delivering waits until it is aborted (a slow push). */
  deliverHangs = false;

  async deliver(
    prepared: PreparedRun,
    _run: RunPayload,
    _result: RunStepResult,
    signal: AbortSignal,
  ) {
    this.calls.push(['deliver', prepared.runId]);
    this.onCall?.('deliver');
    if (this.deliverFailure) throw this.deliverFailure;
    if (this.deliverHangs) {
      await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      );
    }
    return this.delivery;
  }
  async locate(run: RunPayload) {
    this.calls.push(['locate', run.runId]);
    if (this.locateFailure) throw this.locateFailure;
    return {
      prepared: {
        runId: run.runId,
        runDir: `/data/runs/${run.runId}`,
        repoDir: `/data/runs/${run.runId}/repo`,
        runBranch: REPORT.runBranch,
        startCommit: run.startCommit,
        env: { COMPOSE_PROJECT_NAME: 'studio-run-0b8e5c2d1f3a' },
      },
      result: { outcome: 'done' as const, summary: 'Kept result.' },
    };
  }
}

class RecordingApi implements WorkerApi {
  readonly calls: [string, string, unknown?][] = [];
  claims = 0;
  heartbeatError: Error | undefined;
  /** What the heartbeat answers: whether the operator asked to cancel (Issue #100). */
  cancelRequested = false;
  /** Issue #100: while set, every report fails as if Studio were unreachable. */
  studioDown: Error | undefined;
  eventsError: Error | undefined;
  claimError: Error | undefined;
  statusError: Error | undefined;
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
  /**
   * Review of #121: reports Studio applies but whose answer is lost (a network error after the
   * commit), by label: `running`, `step`, or the end state.
   */
  readonly loseAnswerOf = new Set<string>();
  /** Review of #121: the next state report is refused with this error. */
  stateRefusal: Error | undefined;
  private answer(label: string) {
    if (!this.loseAnswerOf.delete(label)) return;
    throw new TypeError('fetch failed: the answer was lost');
  }
  async reportState(runId: string, report: { state: string }) {
    if (this.studioDown) throw this.studioDown;
    if (this.stateRefusal) {
      const refusal = this.stateRefusal;
      this.stateRefusal = undefined;
      throw refusal;
    }
    this.calls.push(['state', runId, report]);
    this.answer(report.state);
  }
  async reportStep(runId: string, step: unknown) {
    if (this.studioDown) throw this.studioDown;
    this.calls.push(['step', runId, step]);
    this.answer('step');
  }
  async reportStatus(status: unknown) {
    this.calls.push(['status', '', status]);
    if (this.statusError) throw this.statusError;
  }
  async heartbeat(runId: string) {
    this.calls.push(['heartbeat', runId]);
    if (this.studioDown) throw this.studioDown;
    if (this.heartbeatError) throw this.heartbeatError;
    return { cancelRequested: this.cancelRequested };
  }
  async appendEvents(runId: string, events: RunEventInput[]) {
    if (this.studioDown) throw this.studioDown;
    if (this.eventsError) throw this.eventsError;
    this.calls.push(['events', runId, events]);
  }
  reports() {
    return this.calls.filter(
      ([kind]) => kind !== 'heartbeat' && kind !== 'status' && kind !== 'events',
    );
  }
  events() {
    return this.calls
      .filter(([kind]) => kind === 'events')
      .flatMap(([, , events]) => events as RunEventInput[]);
  }
}

const STATUS = { runner: 'fake', providers: { claude_code: true, codex: true } } as const;
const silent = { info: () => undefined, error: () => undefined };
let worker: AgentWorker | undefined;

/** Issue #100: the Run step's process groups and the Run's containers, as recording fakes. */
class FakeProcesses {
  terminated: { graceMs: number }[] = [];
  released = 0;
  register() {}
  async terminate(graceMs: number) {
    this.terminated.push({ graceMs });
    return [];
  }
  async release() {
    this.released++;
  }
}
class FakeResources {
  readonly cleaned: string[] = [];
  async cleanUp(project: string) {
    this.cleaned.push(project);
  }
}

interface Extras {
  processes?: FakeProcesses;
  resources?: FakeResources;
  killGraceMs?: number;
  minuteMs?: number;
  gate?: { assertEnabled(provider: string): void };
}

function startWorker(
  api: RecordingApi,
  runner: Runner = new FakeRunner({ slowMs: 60_000 }),
  workingCopies: WorkingCopyPort = new FakeWorkingCopies(),
  /** The Deliveries fake (Issue #102), or the Issue #100 extras. */
  fourth: DeliveryPort | Extras = {},
  more: Extras = {},
) {
  const delivers = 'deliver' in fourth;
  const deliveries: DeliveryPort = delivers ? fourth : new FakeDeliveries();
  const extras: Extras = delivers ? more : fourth;
  const processes = extras.processes ?? new FakeProcesses();
  worker = new AgentWorker({
    api,
    runner,
    gate: extras.gate ?? { assertEnabled: () => undefined },
    status: STATUS,
    workingCopies,
    resources: extras.resources ?? new FakeResources(),
    deliveries,
    pollMs: 5,
    heartbeatMs: 10,
    killGraceMs: extras.killGraceMs ?? 50,
    minuteMs: extras.minuteMs,
    reportBackoff: { initialMs: 5, maxMs: 20 },
    processesFor: () => processes,
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
  it('carries a Run to succeeded: running, the step result, succeeded with its delivery', async () => {
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
          index: 1,
          kind: 'start',
          result: expect.objectContaining({ outcome: 'done' }),
          workingCopy: REPORT,
        },
      ],
      ['state', run.runId, { state: 'succeeded', delivery: DELIVERED }],
    ]);
  });

  it('commits what is left before the step report, and delivers after it (Issue #102)', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    const deliveries = new FakeDeliveries();
    const seen: Record<string, number> = {};
    deliveries.onCall = (step) => (seen[step] = api.reports().length);
    startWorker(api, undefined, undefined, deliveries);

    await until(() => api.reports().length === 3);

    expect(deliveries.calls).toEqual([
      ['commit', 'The fake agent finished the task.'],
      ['deliver', run.runId],
    ]);
    // After "running"; the step report (with the worker's commit) comes between the two.
    expect(seen).toEqual({ commit: 1, deliver: 2 });
  });

  it('reports "No changes" as succeeded with the delivery none (Issue #102)', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    const deliveries = new FakeDeliveries();
    deliveries.delivery = { outcome: 'none' };
    startWorker(api, undefined, undefined, deliveries);

    await until(() => api.reports().length === 3);

    expect(api.reports()[2]).toEqual([
      'state',
      run.runId,
      { state: 'succeeded', delivery: { outcome: 'none' } },
    ]);
  });

  it('reports a failed delivery as delivery_failed, after the step result (Issue #102)', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    const deliveries = new FakeDeliveries();
    deliveries.deliverFailure = new DeliveryFailedError('Pushing the Run branch was refused.');
    startWorker(api, undefined, undefined, deliveries);

    await until(() => api.reports().length === 3);

    expect(api.reports()[1]?.[0]).toBe('step');
    expect(api.reports()[2]).toEqual([
      'state',
      run.runId,
      {
        state: 'failed',
        failure: { code: 'delivery_failed', detail: 'Pushing the Run branch was refused.' },
        workingCopy: REPORT,
      },
    ]);
  });

  it('still reports the step result when committing the leftovers fails (Issue #102)', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    const deliveries = new FakeDeliveries();
    deliveries.commitFailure = new DeliveryFailedError('Not on the Run branch.');
    startWorker(api, undefined, undefined, deliveries);

    await until(() => api.reports().length === 3);

    expect(api.reports()[1]?.[0]).toBe('step');
    expect(api.reports()[2]?.[2]).toMatchObject({
      state: 'failed',
      failure: { code: 'delivery_failed', detail: 'Not on the Run branch.' },
    });
    expect(deliveries.calls.map(([step]) => step)).toEqual(['commit']);
  });

  it('reports a stop during the delivery as delivery_failed, so it can be retried (review of #122)', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    const deliveries = new FakeDeliveries();
    deliveries.deliverHangs = true;
    const running = startWorker(api, undefined, undefined, deliveries);
    await until(() => deliveries.calls.some(([step]) => step === 'deliver'));

    await running.stop();

    expect(api.reports().at(-1)?.[2]).toMatchObject({
      state: 'failed',
      failure: { code: 'delivery_failed', detail: expect.stringContaining('shut down') },
    });
  });

  it('delivers nothing for a question or a failed Run (Issue #102)', async () => {
    const api = new RecordingApi([payload('[fake:question]'), payload('[fake:fail]', 2)]);
    const deliveries = new FakeDeliveries();
    startWorker(api, undefined, undefined, deliveries);

    await until(() => api.reports().length === 5);

    expect(deliveries.calls).toEqual([]);
  });

  it('on a delivery claim only delivers from the kept Working copy: no preparation, no step (Issue #102)', async () => {
    const run = {
      ...payload('Add a feature'),
      kind: 'deliver' as const,
      runBranch: REPORT.runBranch,
    };
    const api = new RecordingApi([run]);
    const workingCopies = new FakeWorkingCopies();
    const deliveries = new FakeDeliveries();
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
    startWorker(api, runner, workingCopies, deliveries);

    await until(() => api.reports().length === 1);

    expect(api.reports()).toEqual([
      ['state', run.runId, { state: 'succeeded', delivery: DELIVERED, workingCopy: REPORT }],
    ]);
    expect(deliveries.calls).toEqual([
      ['locate', run.runId],
      ['commit', 'Kept result.'],
      ['deliver', run.runId],
    ]);
    expect(started).toBe(false);
    expect(workingCopies.prepared).toEqual([]);
  });

  it('reports a delivery retry whose Working copy is gone as delivery_failed (Issue #102)', async () => {
    const run = {
      ...payload('Add a feature'),
      kind: 'deliver' as const,
      runBranch: REPORT.runBranch,
    };
    const api = new RecordingApi([run]);
    const deliveries = new FakeDeliveries();
    deliveries.locateFailure = new DeliveryFailedError('Working copy no longer exists.');
    startWorker(api, undefined, undefined, deliveries);

    await until(() => api.reports().length === 1);

    expect(api.reports()).toEqual([
      [
        'state',
        run.runId,
        {
          state: 'failed',
          failure: { code: 'delivery_failed', detail: 'Working copy no longer exists.' },
        },
      ],
    ]);
  });

  it('keeps every failure of a delivery retry a delivery_failed, without the error text (Issue #102)', async () => {
    const run = {
      ...payload('Add a feature'),
      kind: 'deliver' as const,
      runBranch: REPORT.runBranch,
    };
    const api = new RecordingApi([run]);
    const deliveries = new FakeDeliveries();
    deliveries.deliverFailure = new Error('EACCES: /secret/path');
    startWorker(api, undefined, undefined, deliveries);

    await until(() => api.reports().length === 1);

    expect(api.reports()[0]?.[2]).toMatchObject({
      state: 'failed',
      failure: { code: 'delivery_failed' },
      workingCopy: REPORT,
    });
    expect(JSON.stringify(api.reports())).not.toContain('/secret/path');
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

  it('gives the Environment file to the Working copy only, never to the runner (Issue #104)', async () => {
    const inputs: StartRunStepInput[] = [];
    const prepared: RunPayload[] = [];
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
    const workingCopies = new FakeWorkingCopies();
    const prepare = workingCopies.prepare.bind(workingCopies);
    workingCopies.prepare = (run) => {
      prepared.push(run);
      return prepare(run);
    };
    const environmentFile = { path: '.env', content: 'DB_PASSWORD=test-only-pw\n' };
    const run = { ...payload('Add a feature'), environmentFile };
    const api = new RecordingApi([run]);
    startWorker(api, recording, workingCopies);

    await until(() => api.reports().length === 3);

    expect(prepared[0]?.environmentFile).toEqual(environmentFile);
    expect(inputs[0]?.run).not.toHaveProperty('environmentFile');
    expect(JSON.stringify(inputs[0])).not.toContain('test-only-pw');
    expect(JSON.stringify(api.calls)).not.toContain('test-only-pw');
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

  it("forwards the step's events between markers, before it reports the step (Issue #99)", async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    startWorker(api);

    await until(() => api.reports().length === 3);

    expect(api.events().map(({ seq, stepIndex, kind }) => [seq, stepIndex, kind])).toEqual([
      [1, 1, 'step_started'],
      [2, 1, 'message'],
      [3, 1, 'command'],
      [4, 1, 'output'],
      [5, 1, 'step_finished'],
    ]);
    expect(api.events().at(-1)?.text).toBe('Run step 1 finished: done');
    const kinds = api.calls.map(([kind]) => kind).filter((kind) => kind !== 'heartbeat');
    expect(kinds.lastIndexOf('events')).toBeLessThan(kinds.indexOf('step'));
  });

  it('forwards the log of a failed step before it reports the failure', async () => {
    const run = payload('[fake:fail]');
    const api = new RecordingApi([run]);
    startWorker(api);

    await until(() => api.reports().length === 2);

    expect(api.events().at(-1)).toMatchObject({
      kind: 'step_finished',
      text: 'Run step 1 ended without a result',
    });
    const kinds = api.calls.map(([kind]) => kind).filter((kind) => kind !== 'heartbeat');
    expect(kinds.lastIndexOf('events')).toBeLessThan(kinds.lastIndexOf('state'));
  });

  it('drops a Run when the events route says it no longer holds it', async () => {
    const run = payload('[fake:slow]');
    const api = new RecordingApi([run]);
    api.eventsError = new StudioApiError(
      409,
      '/api/worker/runs/x/events',
      'urn:agentic-studio:problem:run-not-held',
    );
    startWorker(api);

    await until(() => api.claims >= 2);

    expect(api.reports()).toEqual([['state', run.runId, { state: 'running' }]]);
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

  it('reports its status before every claim (Issue #101)', async () => {
    const api = new RecordingApi([]);
    startWorker(api);

    await until(() => api.claims >= 3);

    const kinds = api.calls.map(([kind]) => kind).slice(0, 3);
    expect(kinds).toEqual(['status', 'status', 'status']);
    expect(api.calls[0]?.[2]).toEqual(STATUS);
  });

  it('keeps its status fresh with every heartbeat while it carries a long Run', async () => {
    const api = new RecordingApi([payload('[fake:slow]')]);
    startWorker(api);
    await until(() => api.claims === 1);
    const before = api.calls.filter(([kind]) => kind === 'status').length;

    await until(() => api.calls.filter(([kind]) => kind === 'heartbeat').length >= 3);

    expect(api.calls.filter(([kind]) => kind === 'status').length).toBeGreaterThan(before + 1);
  });

  it('keeps polling and carrying Runs when the status report fails', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    api.statusError = new TypeError('fetch failed');
    startWorker(api);

    await until(() => api.reports().length === 3);

    expect(api.reports().at(-1)).toEqual([
      'state',
      run.runId,
      { state: 'succeeded', delivery: DELIVERED },
    ]);
  });

  it('drops a Run the API says it no longer holds, without reporting it', async () => {
    const run = payload('[fake:slow]');
    const api = new RecordingApi([run]);
    api.heartbeatError = new StudioApiError(
      409,
      '/api/worker/runs/x/heartbeat',
      'urn:agentic-studio:problem:run-not-held',
    );
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

  // Issue #100: cancel, the time limit, the step limit, a Studio outage.
  describe('cancel and limits (Issue #100)', () => {
    it('stops a running step when the heartbeat carries a cancel, and reports cancelled', async () => {
      const run = payload('[fake:slow]');
      const api = new RecordingApi([run]);
      const processes = new FakeProcesses();
      const resources = new FakeResources();
      startWorker(api, undefined, undefined, { processes, resources });
      await until(() => api.reports().length === 1);

      api.cancelRequested = true;
      await until(() => api.reports().length === 2);

      expect(api.reports()).toEqual([
        ['state', run.runId, { state: 'running' }],
        ['state', run.runId, { state: 'cancelled', workingCopy: REPORT }],
      ]);
      // The step's process groups are stopped and the Run's containers removed.
      expect(processes.terminated).toEqual([{ graceMs: 50 }]);
      expect(processes.released).toBe(1);
      expect(resources.cleaned).toEqual(['studio-run-0b8e5c2d1f3a']);
    });

    it('cancels while the Working copy is being prepared, before the step starts', async () => {
      const run = payload('Add a feature');
      const api = new RecordingApi([run]);
      api.cancelRequested = true;
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
      const workingCopies = new FakeWorkingCopies();
      // Preparation lasts until the cancel has been delivered and aborts it.
      workingCopies.prepare = (_run: RunPayload, signal?: AbortSignal) =>
        new Promise<PreparedRun>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('git killed')));
        });
      const resources = new FakeResources();
      startWorker(api, runner, workingCopies, { resources });

      await until(() => api.reports().length === 1);

      expect(api.reports()).toEqual([['state', run.runId, { state: 'cancelled' }]]);
      expect(started).toBe(false);
      expect(resources.cleaned).toEqual([]);
    });

    it('gives up on a step that ignores the stop after the grace period (the hard path)', async () => {
      const run = payload('[fake:stubborn]');
      const api = new RecordingApi([run]);
      const processes = new FakeProcesses();
      startWorker(api, new FakeRunner({ slowMs: 60_000 }), undefined, {
        processes,
        killGraceMs: 30,
      });
      await until(() => api.reports().length === 1);
      const started = Date.now();

      api.cancelRequested = true;
      await until(() => api.reports().length === 2, 3000);

      expect(api.reports()[1]?.[2]).toMatchObject({ state: 'cancelled' });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(processes.terminated).toHaveLength(1);
    });

    it('stops a step at its time limit and reports timed_out', async () => {
      const run = { ...payload('[fake:slow]'), limits: { stepMinutes: 1, maxSteps: 10 } };
      const api = new RecordingApi([run]);
      const resources = new FakeResources();
      // One "minute" of the time limit lasts 40 ms here.
      startWorker(api, undefined, undefined, { minuteMs: 40, resources });

      await until(() => api.reports().length === 2);

      expect(api.reports()[1]).toEqual([
        'state',
        run.runId,
        { state: 'timed_out', workingCopy: REPORT },
      ]);
      expect(resources.cleaned).toEqual(['studio-run-0b8e5c2d1f3a']);
    });

    it('does not time out a step that ends within its limit', async () => {
      const run = { ...payload('Add a feature'), limits: { stepMinutes: 1, maxSteps: 10 } };
      const api = new RecordingApi([run]);
      startWorker(api, undefined, undefined, { minuteMs: 40 });

      await until(() => api.reports().length === 3);
      await delay(80);

      expect(api.reports().at(-1)?.[2]).toMatchObject({ state: 'succeeded' });
    });

    it('refuses to start a step beyond the maximum: failed with step_limit, nothing prepared', async () => {
      const run = { ...payload('Add a feature'), limits: { stepMinutes: 60, maxSteps: 2 } };
      const api = new RecordingApi([{ ...run, completedSteps: 2 }]);
      const workingCopies = new FakeWorkingCopies();
      startWorker(api, undefined, workingCopies);

      await until(() => api.reports().length === 1);

      expect(api.reports()).toEqual([
        [
          'state',
          run.runId,
          {
            state: 'failed',
            failure: {
              code: 'step_limit',
              detail: 'The run reached its limit of 2 run steps; no further step was started.',
            },
          },
        ],
      ]);
      expect(workingCopies.prepared).toEqual([]);
    });

    it('checks the provider gate before preparing the Working copy (note on #117)', async () => {
      const run = payload('Add a feature');
      const api = new RecordingApi([run]);
      const workingCopies = new FakeWorkingCopies();
      const gate = {
        assertEnabled: (provider: string) => {
          throw new ProviderDisabledError(provider as 'codex');
        },
      };
      startWorker(api, undefined, workingCopies, { gate });

      await until(() => api.reports().length === 1);

      expect(api.reports()[0]?.[2]).toMatchObject({
        state: 'failed',
        failure: { code: 'provider_disabled' },
      });
      expect(workingCopies.prepared).toEqual([]);
    });

    it('keeps the step going while Studio is unreachable and delivers its reports in order afterwards', async () => {
      const run = payload('[fake:slow]');
      const api = new RecordingApi([run]);
      api.studioDown = new TypeError('fetch failed');
      startWorker(api, new FakeRunner({ slowMs: 100 }));
      await until(() => api.calls.filter(([kind]) => kind === 'heartbeat').length >= 3);
      // The step finished during the outage; nothing could be reported yet, its log neither.
      await delay(150);
      expect(api.reports()).toEqual([]);
      expect(api.calls.filter(([kind]) => kind === 'events')).toEqual([]);

      api.studioDown = undefined;
      await until(() => api.reports().length === 3, 15_000);

      // The log is delivered too, and before the end report (Studio takes events only while
      // the worker holds the Run).
      const events = api.calls
        .filter(([kind]) => kind === 'events')
        .flatMap(([, , batch]) => batch as RunEventInput[]);
      expect(events.map((event) => event.kind)).toContain('step_finished');
      expect(events.map((event) => event.seq)).toEqual(events.map((_event, i) => i + 1));
      const lastEvents = api.calls.findLastIndex(([kind]) => kind === 'events');
      const end = api.calls.findIndex(
        ([kind, , body]) => kind === 'state' && (body as { state: string }).state === 'succeeded',
      );
      expect(lastEvents).toBeLessThan(end);

      expect(
        api.reports().map(([kind, , body]) => [kind, (body as { state?: string }).state]),
      ).toEqual([
        ['state', 'running'],
        ['step', undefined],
        ['state', 'succeeded'],
      ]);
    });

    it('stops buffering and drops the Run when Studio, back, says it no longer holds it', async () => {
      const run = payload('Add a feature');
      const api = new RecordingApi([run]);
      api.studioDown = new StudioApiError(503, '/api/worker/runs/x/state');
      startWorker(api);
      await delay(40);

      api.studioDown = new StudioApiError(
        409,
        '/api/worker/runs/x/state',
        'urn:agentic-studio:problem:run-not-held',
      );
      await until(() => api.claims >= 2);

      expect(api.reports()).toEqual([]);
    });
  });

  // Review of #121: Studio applied a report but the answer was lost; the worker sends it again
  // (Studio treats the repeat as a no-op) and the Run goes on, numbered so nothing is doubled.
  describe('reports whose answer is lost (review of #121)', () => {
    it.each(['running', 'step', 'succeeded'])(
      'sends the %s report again and carries the Run to its end',
      async (label) => {
        const run = payload('Add a feature');
        const api = new RecordingApi([run]);
        api.loseAnswerOf.add(label);
        startWorker(api);

        await until(() => api.reports().length === 4);

        const kinds = api
          .reports()
          .map(([kind, , body]) => (kind === 'state' ? (body as { state: string }).state : kind));
        expect(kinds).toEqual(
          ['running', 'step', 'succeeded'].flatMap((each) =>
            each === label ? [each, each] : [each],
          ),
        );
        const steps = api.reports().filter(([kind]) => kind === 'step');
        expect(steps.every(([, , body]) => (body as { index: number }).index === 1)).toBe(true);
        // Not abandoned: nothing reported failed, and the worker claims the next Run.
        await until(() => api.claims >= 2);
      },
    );

    it('logs a refused report (illegal-run-transition) and goes on; only not-held abandons', async () => {
      const run = payload('Add a feature');
      const api = new RecordingApi([run]);
      api.stateRefusal = new StudioApiError(
        409,
        '/api/worker/runs/x/state',
        'urn:agentic-studio:problem:illegal-run-transition',
      );
      startWorker(api);

      await until(() => api.reports().length === 2);

      expect(api.reports().map(([kind]) => kind)).toEqual(['step', 'state']);
      expect(api.reports()[1]?.[2]).toMatchObject({ state: 'succeeded' });
    });
  });

  // Issue #100 with #102: a cancel stops the Run before anything is pushed; during a push it
  // still ends the Run as cancelled (the push is aborted).
  describe('cancel and delivery', () => {
    it('pushes nothing for a Run cancelled during its step', async () => {
      const run = payload('[fake:slow]');
      const api = new RecordingApi([run]);
      const deliveries = new FakeDeliveries();
      startWorker(api, undefined, undefined, deliveries);
      await until(() => api.reports().length === 1);

      api.cancelRequested = true;
      await until(() => api.reports().length === 2);

      expect(api.reports()[1]?.[2]).toMatchObject({ state: 'cancelled' });
      expect(deliveries.calls.filter(([step]) => step === 'deliver')).toEqual([]);
    });

    it('ends a Run cancelled during its push as cancelled, not as a delivery to retry', async () => {
      const run = payload('Add a feature');
      const api = new RecordingApi([run]);
      const deliveries = new FakeDeliveries();
      deliveries.deliverHangs = true;
      startWorker(api, undefined, undefined, deliveries);
      await until(() => deliveries.calls.some(([step]) => step === 'deliver'));

      api.cancelRequested = true;
      await until(() => api.reports().length === 3);

      expect(api.reports()[2]?.[2]).toMatchObject({ state: 'cancelled' });
    });
  });
});
