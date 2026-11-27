import type {
  RunDelivery,
  RunEventInput,
  RunPayload,
  RunStepResult,
  WorkingCopyReport,
} from '@agentic-studio/contracts';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentFolders } from '../agent-folder.js';
import { runProcess } from '../process-runner.js';
import {
  type BranchUpdatePort,
  type BranchUpdateStart,
  MergeIncompleteError,
} from '../branch-update.js';
import { DeliveryFailedError, type DeliveryPort } from '../delivery.js';
import { FakeRunner, fakeSessionRef } from '../fake-runner.js';
import {
  AgentFailedError,
  type ResumeRunStepInput,
  type Runner,
  type RunStep,
  type StartRunStepInput,
  UsageLimitError,
} from '../runner.js';
import { ModelNotAllowedError, ModelRefusedError } from '../model-option.js';
import { ProviderDisabledError } from '../provider-gate.js';
import type { LookupService } from '../pull-request-lookups.js';
import { type ComputedRunDiff, type RunDiffPort, RunDiffUnavailableError } from '../run-diff.js';
import { StudioApiError } from '../studio-api.js';
import {
  AgentFolderInvalidError,
  AgentFolderTransientError,
  AgentFolderUnavailableError,
} from '../agent-folder.js';
import { type PlacedSkills, RunSkills, SkillsUnusableError } from '../run-skills.js';
import {
  AgentWorker,
  type AgentFolderPort,
  type AgentWorkerOptions,
  type RunSkillsPort,
  SHUTDOWN_FAILURE,
  type WorkerApi,
} from '../worker.js';
import { PreparationFailedError, type PreparedRun, type WorkingCopyPort } from '../working-copy.js';
import { agentFields } from './agent-fixtures.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// The worker loop against a recording fake of the worker routes.
const payload = (task: string, n = 1): RunPayload => ({
  runId: `0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1${n}`,
  projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
  provider: 'codex',
  ...agentFields('codex'),
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

/** A recording fake of the Working copies (the real one: working-copy.linux.test.ts). */
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

  /** The kept Working copies a resume located; `locateFailure` when it is gone. */
  readonly located: string[] = [];
  locateFailure: Error | undefined;

  async locate(run: RunPayload): Promise<PreparedRun> {
    this.located.push(run.runId);
    if (this.locateFailure) throw this.locateFailure;
    return {
      runId: run.runId,
      runDir: `/data/runs/${run.runId}`,
      repoDir: `/data/runs/${run.runId}/repo`,
      runBranch: run.runBranch ?? '',
      startCommit: run.startCommit,
      env: { COMPOSE_PROJECT_NAME: 'studio-run-0b8e5c2d1f3a' },
    };
  }

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

/** A recording fake of the delivery (the real one: delivery.linux.test.ts). */
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
  async keep(_prepared: PreparedRun, result: RunStepResult) {
    this.calls.push(['keep', result.summary]);
    this.onCall?.('keep');
  }
  /** When set, delivering waits until it is aborted (a slow push). */
  deliverHangs = false;
  /** When set, delivering resolves only once this promise does. */
  deliverGate: Promise<void> | undefined;
  /** Thrown once the gate opened. */
  deliverFailureAfterGate: Error | undefined;

  async deliver(
    prepared: PreparedRun,
    _run: RunPayload,
    _result: RunStepResult,
    signal: AbortSignal,
  ) {
    this.calls.push(['deliver', prepared.runId]);
    this.onCall?.('deliver');
    if (this.deliverFailure) throw this.deliverFailure;
    if (this.deliverGate) await this.deliverGate;
    if (this.deliverFailureAfterGate) throw this.deliverFailureAfterGate;
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

/** A diff with one file, as the fake computes it (the real one: run-diff.linux.test.ts). */
const DIFF = {
  baseCommit: 'a'.repeat(40),
  includesUnpushed: true,
  truncated: false,
  files: [{ path: 'src/app.ts', status: 'modified' as const, additions: 1, deletions: 0 }],
};

/** Where the fake's diffs stand. */
const DIFF_STATE = {
  resultTree: 'e'.repeat(40),
  resultCommit: 'c'.repeat(40),
  previousTree: 'f'.repeat(40),
  previousCommit: 'a'.repeat(40),
};

/** A recording fake of the diffs. */
class FakeRunDiffs implements RunDiffPort {
  readonly calls: [string, string, boolean?][] = [];
  failure: Error | undefined;
  async compute(
    prepared: PreparedRun,
    _run: RunPayload,
    _signal: AbortSignal,
    options: { refresh?: boolean } = {},
  ): Promise<ComputedRunDiff> {
    this.calls.push(['compute', prepared.runId, options.refresh ?? false]);
    if (this.failure) throw this.failure;
    return {
      report: { run: DIFF, last: DIFF, state: DIFF_STATE },
      tree: 'e'.repeat(40),
      head: 'c'.repeat(40),
      headTree: 'e'.repeat(40),
      startCommit: 'a'.repeat(40),
    };
  }
  async pushed(prepared: PreparedRun, computed: ComputedRunDiff) {
    this.calls.push(['pushed', prepared.runId]);
    return {
      run: { ...computed.report.run, includesUnpushed: false },
      last: { ...computed.report.last, includesUnpushed: false },
      state: { ...computed.report.state, pushedCommit: 'c'.repeat(40) },
    };
  }
}

/** A recording fake of the branch update (the real one: branch-update.linux.test.ts). */
class FakeBranchUpdates implements BranchUpdatePort {
  /** `start`, `complete <expected>`, `abort <base>` (`-` when none), in order. */
  readonly calls: string[] = [];
  /** What starting the update finds. */
  start_: BranchUpdateStart = {
    outcome: 'merged',
    commit: 'd'.repeat(40),
    baseCommit: 'b'.repeat(40),
  };
  /** Thrown by starting the update (a fetch that failed). */
  startFailure: Error | undefined;
  /** What completing an open merge returns; `null`: no merge was open. */
  completion: { mergedCommit: string; completed: boolean } | null = null;
  completeFailure: Error | undefined;
  async start(): Promise<BranchUpdateStart> {
    this.calls.push('start');
    if (this.startFailure) throw this.startFailure;
    return this.start_;
  }
  async complete(
    _prepared: PreparedRun,
    _run: RunPayload,
    _signal: AbortSignal,
    expected?: string,
  ) {
    this.calls.push(`complete ${expected ?? '-'}`);
    if (this.completeFailure) throw this.completeFailure;
    return this.completion;
  }
  /** Whether an abort finds something to undo (a merge an earlier part left open). */
  undoes = false;
  async abort(_prepared: PreparedRun, baseCommit?: string) {
    this.calls.push(`abort ${baseCommit ?? '-'}`);
    return this.undoes;
  }
}

class FakeLookups implements LookupService {
  served = 0;
  readonly asked: string[] = [];
  /** The pull request state a Follow-up reads. */
  state: 'draft' | 'open' | 'merged' | 'closed' | 'missing' | 'unknown' = 'open';
  /** The next serve fails with this. */
  failure: Error | undefined;
  async serve(): Promise<number> {
    this.served++;
    if (this.failure) {
      const failure = this.failure;
      this.failure = undefined;
      throw failure;
    }
    return 0;
  }
  async followUpState(run: RunPayload) {
    this.asked.push(run.runId);
    return this.state;
  }
}

class RecordingApi implements WorkerApi {
  readonly calls: [string, string, unknown?][] = [];
  claims = 0;
  heartbeatError: Error | undefined;
  /** What the heartbeat answers: whether the operator asked to cancel. */
  cancelRequested = false;
  /** While set, every report fails as if Studio were unreachable. */
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
  /** Reports Studio applies but whose answer is lost, by label: running, step or the end state. */
  readonly loseAnswerOf = new Set<string>();
  /** The next state report is refused with this error. */
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
  async reportDiff(runId: string, report: unknown) {
    if (this.studioDown) throw this.studioDown;
    this.calls.push(['diff', runId, report]);
  }
  /** The state and step reports; the diffs have their own tests. */
  reports() {
    return this.calls.filter(
      ([kind]) => kind !== 'heartbeat' && kind !== 'status' && kind !== 'events' && kind !== 'diff',
    );
  }
  /** The state, step and diff reports, in the order Studio got them. */
  reportsWithDiffs() {
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

/** The Run step's process groups and the Run's containers, as recording fakes. */
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
  diffs?: RunDiffPort;
  lookups?: LookupService;
  branchUpdates?: BranchUpdatePort;
  disk?: { snapshot(): unknown };
  agentFolders?: AgentFolderPort;
  skills?: RunSkillsPort;
}

function startWorker(
  api: RecordingApi,
  runner: Runner = new FakeRunner({ slowMs: 60_000 }),
  workingCopies: WorkingCopyPort = new FakeWorkingCopies(),
  /** The Deliveries fake, or the step-process extras. */
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
    branchUpdates: extras.branchUpdates ?? new FakeBranchUpdates(),
    diffs: extras.diffs ?? new FakeRunDiffs(),
    ...(extras.lookups ? { lookups: extras.lookups } : {}),
    ...(extras.agentFolders ? { agentFolders: extras.agentFolders } : {}),
    ...(extras.skills ? { skills: extras.skills } : {}),
    ...(extras.disk ? { disk: extras.disk as AgentWorkerOptions['disk'] } : {}),
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
  describe('lookups', () => {
    it('serves lookups while it is idle, and keeps going after a failed serve', async () => {
      const lookups = new FakeLookups();
      lookups.failure = new Error('The Studio API answered 500');
      startWorker(new RecordingApi([]), undefined, undefined, { lookups });

      await until(() => lookups.served >= 3);
    });

    it('serves lookups while it carries a long Run step', async () => {
      const run = payload('Work for a long time [fake:long]');
      const api = new RecordingApi([run]);
      const lookups = new FakeLookups();
      startWorker(api, new FakeRunner({ slowMs: 60_000 }), undefined, { lookups });

      await until(() => api.reports().length === 1);
      const before = lookups.served;
      await until(() => lookups.served >= before + 3);

      expect(api.reports()).toHaveLength(1);
    });

    it('serves nothing without lookups configured', async () => {
      const api = new RecordingApi([]);
      startWorker(api);

      await until(() => api.claims >= 2);
    });
  });

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

  it('commits what is left before the step report, and delivers after it', async () => {
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

  it('reports "No changes" as succeeded with the delivery none', async () => {
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

  it('reports a failed delivery as delivery_failed, after the step result', async () => {
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

  it('still reports the step result when committing the leftovers fails', async () => {
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

  it('reports a stop during the delivery as delivery_failed, so it can be retried', async () => {
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

  describe("the Run's diffs", () => {
    const kinds = (api: RecordingApi) =>
      api
        .reportsWithDiffs()
        .map(([kind, , report]) => (kind === 'state' ? (report as { state: string }).state : kind));
    const diffsSent = (api: RecordingApi) =>
      api.calls.filter(([kind]) => kind === 'diff').map(([, , report]) => report);

    it('reports them after the step result and, once the delivery pushed, again as pushed', async () => {
      const run = payload('Add a feature');
      const api = new RecordingApi([run]);
      const diffs = new FakeRunDiffs();
      startWorker(api, undefined, undefined, new FakeDeliveries(), { diffs });

      await until(() => api.reports().length === 3);

      expect(kinds(api)).toEqual(['running', 'step', 'diff', 'diff', 'succeeded']);
      expect(diffsSent(api)).toEqual([
        { run: DIFF, last: DIFF, state: DIFF_STATE },
        {
          run: { ...DIFF, includesUnpushed: false },
          last: { ...DIFF, includesUnpushed: false },
          state: { ...DIFF_STATE, pushedCommit: 'c'.repeat(40) },
        },
      ]);
      expect(diffs.calls).toEqual([
        ['compute', run.runId, false],
        ['pushed', run.runId],
      ]);
    });

    it('reports them once when nothing was pushed', async () => {
      const api = new RecordingApi([payload('Add a feature')]);
      const deliveries = new FakeDeliveries();
      deliveries.delivery = { outcome: 'none' };
      startWorker(api, undefined, undefined, deliveries);

      await until(() => api.reports().length === 3);

      expect(kinds(api)).toEqual(['running', 'step', 'diff', 'succeeded']);
    });

    it('reports them after a question, before the Run waits for the operator', async () => {
      const api = new RecordingApi([payload('[fake:question]')]);
      startWorker(api);

      await until(() => api.reports().length === 3);

      expect(kinds(api)).toEqual(['running', 'step', 'diff', 'waiting_for_operator']);
    });

    it('reports why they could not be computed, and the Run goes on', async () => {
      const api = new RecordingApi([payload('Add a feature')]);
      const diffs = new FakeRunDiffs();
      diffs.failure = new RunDiffUnavailableError(
        'The changes could not be computed (git write-tree exited with code 128).',
      );
      startWorker(api, undefined, undefined, new FakeDeliveries(), { diffs });

      await until(() => api.reports().length === 3);

      expect(kinds(api)).toEqual(['running', 'step', 'diff', 'succeeded']);
      expect(diffsSent(api)).toEqual([
        { unavailable: 'The changes could not be computed (git write-tree exited with code 128).' },
      ]);
    });

    it('never sends the text of an unexpected error', async () => {
      const api = new RecordingApi([payload('Add a feature')]);
      const diffs = new FakeRunDiffs();
      diffs.failure = new Error('EACCES: /data/runs/secret-path');
      startWorker(api, undefined, undefined, new FakeDeliveries(), { diffs });

      await until(() => api.reports().length === 3);

      expect(diffsSent(api)).toEqual([
        { unavailable: 'The changes could not be computed. The agent worker log has the details.' },
      ]);
    });

    it('reports nothing for a step that ended without a result', async () => {
      const api = new RecordingApi([payload('[fake:fail]')]);
      const diffs = new FakeRunDiffs();
      startWorker(api, undefined, undefined, new FakeDeliveries(), { diffs });

      await until(() => api.reports().length === 2);

      expect(kinds(api)).toEqual(['running', 'failed']);
      expect(diffs.calls).toEqual([]);
    });

    it('a delivery retry that pushed reports them again, refreshed, before its outcome', async () => {
      const run = {
        ...payload('Add a feature'),
        kind: 'deliver' as const,
        runBranch: REPORT.runBranch,
        nextSeq: 7,
      };
      const api = new RecordingApi([run]);
      const diffs = new FakeRunDiffs();
      startWorker(api, undefined, new FakeWorkingCopies(), new FakeDeliveries(), { diffs });

      await until(() => api.reports().length === 1);

      expect(kinds(api)).toEqual(['diff', 'diff', 'succeeded']);
      expect(diffs.calls).toEqual([
        ['compute', run.runId, true],
        ['pushed', run.runId],
      ]);
    });

    it('a delivery retry reports them whatever its outcome', async () => {
      const retry = (n: number) => ({
        ...payload('Add a feature', n),
        kind: 'deliver' as const,
        runBranch: REPORT.runBranch,
        nextSeq: 7,
      });
      const nothing = retry(1);
      const refused = retry(2);
      const api = new RecordingApi([nothing, refused]);
      const deliveries = new FakeDeliveries();
      deliveries.delivery = { outcome: 'none' };
      deliveries.onCall = (step) => {
        if (
          step === 'deliver' &&
          deliveries.calls.filter(([name]) => name === 'deliver').length === 2
        ) {
          deliveries.deliverFailure = new DeliveryFailedError('GitHub refused the pull request.');
        }
      };
      startWorker(api, undefined, new FakeWorkingCopies(), deliveries);

      await until(() => api.reports().length === 2);

      const byRun = (runId: string) =>
        api
          .reportsWithDiffs()
          .filter(([, id]) => id === runId)
          .map(([kind, , report]) =>
            kind === 'state' ? (report as { state: string }).state : kind,
          );
      expect(byRun(nothing.runId)).toEqual(['diff', 'succeeded']);
      expect(byRun(refused.runId)).toEqual(['diff', 'failed']);
    });
  });

  it('delivers nothing for a question or a failed Run', async () => {
    const api = new RecordingApi([payload('[fake:question]'), payload('[fake:fail]', 2)]);
    const deliveries = new FakeDeliveries();
    startWorker(api, undefined, undefined, deliveries);

    await until(() => api.reports().length === 5);

    expect(deliveries.calls).toEqual([]);
  });

  it('on a delivery claim only delivers from the kept Working copy: no preparation, no step', async () => {
    const run = {
      ...payload('Add a feature'),
      kind: 'deliver' as const,
      runBranch: REPORT.runBranch,
      nextSeq: 7,
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

  it('reports a delivery retry whose Working copy is gone as delivery_failed', async () => {
    const run = {
      ...payload('Add a feature'),
      kind: 'deliver' as const,
      runBranch: REPORT.runBranch,
      nextSeq: 7,
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

  it('keeps every failure of a delivery retry a delivery_failed, without the error text', async () => {
    const run = {
      ...payload('Add a feature'),
      kind: 'deliver' as const,
      runBranch: REPORT.runBranch,
      nextSeq: 7,
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

  it('prepares the Working copy while preparing, before it reports running', async () => {
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

  it('runs the step in the Working copy with the Run step environment', async () => {
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

  it('gives the Environment file to the Working copy only, never to the runner', async () => {
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

  it('fails the Run with preparation_failed and its detail, starting no Run step', async () => {
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

  it("sends a crashed step's Working copy state with the failure", async () => {
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

  it("forwards the step's events between markers, before it reports the step", async () => {
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

  it.each([
    [new ModelNotAllowedError('claude_code', 'gpt-6-luna'), 'model_not_allowed'],
    [new ModelRefusedError('opus', 'Its error output: no access to it.'), 'model_refused'],
  ])('reports %s as its own failure code', async (error, code) => {
    const refused: Runner = {
      async *start(): RunStep {
        yield { type: 'notice', text: 'About to start.' };
        throw error;
      },
      resume: () => {
        throw new Error('not used');
      },
    };
    const run = payload('x');
    const api = new RecordingApi([run]);
    startWorker(api, refused);

    await until(() => api.reports().length === 2);

    expect(api.reports()[1]).toEqual([
      'state',
      run.runId,
      { state: 'failed', failure: { code, detail: error.message }, workingCopy: REPORT },
    ]);
  });

  it('reports a usage limit as usage_limit, with the session to resume later', async () => {
    const limited: Runner = {
      async *start(): RunStep {
        yield { type: 'notice', text: 'Usage limit reached.' };
        throw new UsageLimitError(
          'The Claude Code usage limit was reached; it resets at 2026-11-16T17:00:00.000Z.',
          'session-42',
        );
      },
      resume: () => {
        throw new Error('not used');
      },
    };
    const run = payload('x');
    const api = new RecordingApi([run]);
    startWorker(api, limited);

    await until(() => api.reports().length === 2);

    expect(api.reports()[1]).toEqual([
      'state',
      run.runId,
      {
        state: 'failed',
        failure: {
          code: 'usage_limit',
          detail: 'The Claude Code usage limit was reached; it resets at 2026-11-16T17:00:00.000Z.',
        },
        workingCopy: REPORT,
        sessionRef: 'session-42',
      },
    ]);
    expect(api.events().map((event) => event.kind)).toContain('notice');
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

  it('reports its status before every claim', async () => {
    const api = new RecordingApi([]);
    startWorker(api);

    await until(() => api.claims >= 3);

    const kinds = api.calls.map(([kind]) => kind).slice(0, 3);
    expect(kinds).toEqual(['status', 'status', 'status']);
    expect(api.calls[0]?.[2]).toEqual(STATUS);
  });

  it('adds the disk figures to its status report once they are measured', async () => {
    const figures = {
      workingCopiesBytes: 5_000_000,
      cachesBytes: 1_000_000,
      keptRuns: 3,
      freeBytes: 80_000_000_000,
      totalBytes: 200_000_000_000,
      minFreeBytes: 10_737_418_240,
    };
    const measured: { figures: typeof figures | undefined } = { figures: undefined };
    const api = new RecordingApi([]);
    startWorker(api, undefined, undefined, { disk: { snapshot: () => measured.figures } });
    await until(() => api.claims >= 2);

    expect(api.calls.find(([kind]) => kind === 'status')?.[2]).toEqual(STATUS);

    measured.figures = figures;
    const seen = api.calls.length;
    await until(() => api.calls.slice(seen).some(([kind]) => kind === 'status'));
    expect(api.calls.slice(seen).find(([kind]) => kind === 'status')?.[2]).toEqual({
      ...STATUS,
      disk: figures,
    });
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

  it('on stop abandons a call in flight instead of waiting for the API', async () => {
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

  describe('cancel and limits', () => {
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

    it('checks the provider gate before preparing the Working copy', async () => {
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

  describe('reports whose answer is lost', () => {
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

    it('lets a delivery the operator cancels finish, and records its pull request on the cancelled Run', async () => {
      const run = payload('Add a feature');
      const api = new RecordingApi([run]);
      const deliveries = new FakeDeliveries();
      let release!: () => void;
      deliveries.deliverGate = new Promise((resolve) => (release = resolve));
      startWorker(api, undefined, undefined, deliveries);
      await until(() => deliveries.calls.some(([step]) => step === 'deliver'));

      api.cancelRequested = true;
      await until(() => api.calls.filter(([kind]) => kind === 'heartbeat').length >= 3);
      release();
      await until(() => api.reports().length === 3);

      expect(api.reports()[2]?.[2]).toEqual({ state: 'cancelled', delivery: DELIVERED });
    });
  });

  it('records the pushed Run branch when the pull request fails after a cancel', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    const deliveries = new FakeDeliveries();
    let release!: () => void;
    deliveries.deliverGate = new Promise((resolve) => (release = resolve));
    deliveries.deliverFailureAfterGate = new DeliveryFailedError('GitHub answered 502.', true);
    startWorker(api, undefined, undefined, deliveries);
    await until(() => deliveries.calls.some(([step]) => step === 'deliver'));

    api.cancelRequested = true;
    await until(() => api.calls.filter(([kind]) => kind === 'heartbeat').length >= 3);
    release();
    await until(() => api.reports().length === 3);

    expect(api.reports()[2]?.[2]).toMatchObject({
      state: 'cancelled',
      delivery: { outcome: 'none', branchPushed: true },
    });
  });
  describe('resume', () => {
    const resumePayload = (task: string, completedSteps = 1, n = 1): RunPayload => ({
      ...payload(task, n),
      kind: 'resume',
      runBranch: REPORT.runBranch,
      sessionRef: fakeSessionRef(payload(task, n).runId),
      answer: 'Option A',
      resumeReason: 'answer',
      nextSeq: 10,
      completedSteps,
    });

    /** A runner that records the resume it was asked for, then finishes. */
    class RecordingRunner implements Runner {
      readonly resumed: ResumeRunStepInput[] = [];
      // eslint-disable-next-line require-yield
      async *start(): RunStep {
        throw new Error('not used');
      }
      async *resume(input: ResumeRunStepInput): RunStep {
        this.resumed.push(input);
        yield { type: 'message', text: 'resumed' };
        return { outcome: 'done', summary: 'Resumed and finished.' };
      }
    }

    it('resumes the same session with the answer as the next Run step, in the kept Working copy', async () => {
      const run = resumePayload('[fake:question]');
      const api = new RecordingApi([run]);
      const runner = new RecordingRunner();
      const workingCopies = new FakeWorkingCopies();
      startWorker(api, runner, workingCopies);

      await until(() => api.reports().length === 3);

      expect(workingCopies.prepared).toEqual([]);
      expect(workingCopies.located).toEqual([run.runId]);
      expect(runner.resumed).toHaveLength(1);
      expect(runner.resumed[0]).toMatchObject({
        sessionRef: run.sessionRef,
        answer: 'Option A',
        reason: 'answer',
        workspace: { repoDir: `/data/runs/${run.runId}/repo` },
        run: { baseRules: { version: expect.any(String) } },
      });
      expect(api.reports()).toEqual([
        ['state', run.runId, { state: 'running' }],
        [
          'step',
          run.runId,
          {
            index: 2,
            kind: 'resume',
            result: { outcome: 'done', summary: 'Resumed and finished.' },
            workingCopy: REPORT,
          },
        ],
        ['state', run.runId, { state: 'succeeded', delivery: DELIVERED }],
      ]);
    });

    it("continues a delivery retry's log after the stored events", async () => {
      const run = {
        ...payload('Add a feature'),
        kind: 'deliver' as const,
        runBranch: REPORT.runBranch,
        nextSeq: 7,
        completedSteps: 2,
      };
      const api = new RecordingApi([run]);
      const deliveries = new FakeDeliveries();
      deliveries.deliverHangs = true;
      startWorker(api, undefined, undefined, deliveries);
      await until(() => deliveries.calls.some(([step]) => step === 'deliver'));

      api.cancelRequested = true;
      await until(() => api.reports().length === 1 && api.events().length > 0);

      expect(api.events()[0]).toMatchObject({ seq: 7, stepIndex: 2, kind: 'notice' });
    });

    it("numbers the resumed step's events after the stored log", async () => {
      const run = resumePayload('[fake:question]');
      const api = new RecordingApi([run]);
      startWorker(api);

      await until(() => api.reports().length === 3 && api.events().length >= 3);

      const events = api.events();
      expect(events[0]).toMatchObject({ seq: 10, stepIndex: 2, kind: 'step_started' });
      expect(events.map((event) => event.seq)).toEqual(events.map((_event, i) => 10 + i));
      expect(events.every((event) => event.stepIndex === 2)).toBe(true);
    });

    it('reports a second question as waiting_for_operator again', async () => {
      const run = resumePayload('[fake:question-twice]');
      const api = new RecordingApi([run]);
      startWorker(api);

      await until(() => api.reports().length === 3);

      expect(api.reports()[1]?.[2]).toMatchObject({
        index: 2,
        kind: 'resume',
        result: { outcome: 'needs_input', sessionRef: run.sessionRef },
      });
      expect(api.reports()[2]).toEqual(['state', run.runId, { state: 'waiting_for_operator' }]);
    });

    it('fails as preparation_failed when the Working copy is gone, without resuming', async () => {
      const run = resumePayload('[fake:question]');
      const api = new RecordingApi([run]);
      const runner = new RecordingRunner();
      const workingCopies = new FakeWorkingCopies();
      workingCopies.locateFailure = new PreparationFailedError(
        'Working copy no longer exists — run again.',
      );
      startWorker(api, runner, workingCopies);

      await until(() => api.reports().length === 1);

      expect(api.reports()[0]).toEqual([
        'state',
        run.runId,
        {
          state: 'failed',
          failure: {
            code: 'preparation_failed',
            detail: 'Working copy no longer exists — run again.',
          },
        },
      ]);
      expect(runner.resumed).toEqual([]);
    });

    it('fails as agent_failed when the provider refuses the session', async () => {
      const run = { ...resumePayload('[fake:question]'), sessionRef: 'someone-elses-session' };
      const api = new RecordingApi([run]);
      startWorker(api);

      await until(() => api.reports().length === 2);

      expect(api.reports()[1]?.[2]).toMatchObject({
        state: 'failed',
        failure: { code: 'agent_failed', detail: expect.stringContaining('no such session') },
      });
    });

    it('refuses a resume beyond the maximum number of Run steps (step_limit), touching nothing', async () => {
      const run = resumePayload('[fake:question]', 10);
      const api = new RecordingApi([run]);
      const workingCopies = new FakeWorkingCopies();
      startWorker(api, undefined, workingCopies);

      await until(() => api.reports().length === 1);

      expect(api.reports()[0]?.[2]).toMatchObject({
        state: 'failed',
        failure: { code: 'step_limit' },
      });
      expect(workingCopies.located).toEqual([]);
    });

    describe('bringing the branch up to date', () => {
      const bringUpPayload = (note: string, overrides: Partial<RunPayload> = {}): RunPayload => ({
        ...resumePayload('Add a feature', 3),
        answer: note,
        resumeReason: 'bring_up_to_date',
        followUpNumber: 2,
        bringUpToDate: true,
        stepsBeforePart: 3,
        pullRequestNumber: 7,
        ...overrides,
      });
      const MERGED = 'd'.repeat(40);
      const BASE = 'b'.repeat(40);
      const notices = (api: RecordingApi) =>
        api
          .events()
          .filter((event) => event.kind === 'notice')
          .map((event) => event.text);
      const stateReports = (api: RecordingApi) =>
        api
          .reports()
          .filter((report) => report[0] === 'state')
          .map((report) => report[2]);
      /** What every new part does first: undo a merge an earlier part left open. */
      const STALE = 'abort -';

      class Recorder implements Runner {
        readonly resumed: ResumeRunStepInput[] = [];
        // eslint-disable-next-line require-yield
        async *start(): RunStep {
          throw new Error('not used');
        }
        async *resume(input: ResumeRunStepInput): RunStep {
          this.resumed.push(input);
          yield { type: 'message', text: 'resumed' };
          return { outcome: 'done', summary: 'Checked.' };
        }
      }

      it("merges first, then resumes the agent with the worker's instruction and the note", async () => {
        const run = bringUpPayload('Keep our config.');
        const api = new RecordingApi([run]);
        const runner = new Recorder();
        const updates = new FakeBranchUpdates();
        const deliveries = new FakeDeliveries();
        startWorker(api, runner, undefined, deliveries, { branchUpdates: updates });

        await until(() => stateReports(api).length === 2);

        expect(runner.resumed[0]).toMatchObject({ reason: 'bring_up_to_date' });
        const told = runner.resumed[0]?.answer ?? '';
        expect(told).toContain('nothing conflicted');
        expect(told).toContain("The operator's note:\n\nKeep our config.");
        expect(told).toContain('`dev` (commit ddddddd)');
        expect(updates.calls).toEqual([STALE, 'start', `complete ${MERGED}`]);
        // Studio is told where the merge started; it holds it for the part's later claims.
        expect(stateReports(api)[0]).toEqual({
          state: 'running',
          bringUpToDateStarted: { baseCommit: BASE, integrationCommit: MERGED },
        });
        expect(stateReports(api)[1]).toMatchObject({
          state: 'succeeded',
          delivery: expect.objectContaining({ outcome: 'delivered' }),
        });
        expect(stateReports(api)[1]).not.toHaveProperty('mergedCommit');
        expect(deliveries.calls.map((call) => call[0])).toEqual(['commit', 'deliver']);
        expect(notices(api)).toEqual([
          'Follow-up 2 started: bring the branch up to date with dev',
          'Merged dev (commit ddddddd) without conflicts',
          'Follow-up 2 ended: done',
        ]);
      });

      it('leaves the default text out of the instruction when there is no note', async () => {
        const run = bringUpPayload('Bring the Run branch up to date.');
        const api = new RecordingApi([run]);
        const runner = new Recorder();
        startWorker(api, runner);

        await until(() => stateReports(api).length === 2);

        expect(runner.resumed[0]?.answer).not.toContain("operator's note");
      });

      it('lists the conflicted files for the agent and completes the merge the agent left open', async () => {
        const run = bringUpPayload('Prefer theirs.');
        const api = new RecordingApi([run]);
        const runner = new Recorder();
        const updates = new FakeBranchUpdates();
        updates.start_ = {
          outcome: 'conflicts',
          commit: MERGED,
          baseCommit: BASE,
          files: ['src/a.ts', 'README.md'],
          moreFiles: 3,
        };
        updates.completion = { mergedCommit: MERGED, completed: true };
        startWorker(api, runner, undefined, { branchUpdates: updates });

        await until(() => stateReports(api).length === 2);

        const told = runner.resumed[0]?.answer ?? '';
        expect(told).toContain('- src/a.ts\n- README.md\n- and 3 more');
        expect(told).toContain("The operator's note:\n\nPrefer theirs.");
        expect(stateReports(api)[1]).toMatchObject({ state: 'succeeded' });
        expect(updates.calls).toEqual([STALE, 'start', `complete ${MERGED}`]);
      });

      it('starts no agent, pushes nothing and reports a branch that was already up to date', async () => {
        const run = bringUpPayload('x');
        const api = new RecordingApi([run]);
        const runner = new Recorder();
        const updates = new FakeBranchUpdates();
        updates.start_ = { outcome: 'already_up_to_date', commit: MERGED };
        const deliveries = new FakeDeliveries();
        startWorker(api, runner, undefined, deliveries, { branchUpdates: updates });

        await until(() => stateReports(api).length === 1);

        expect(stateReports(api)).toEqual([{ state: 'succeeded', unchanged: true }]);
        expect(runner.resumed).toEqual([]);
        expect(deliveries.calls).toEqual([]);
        expect(api.reports().some((report) => report[0] === 'step')).toBe(false);
        expect(notices(api)).toEqual([
          'Follow-up 2 started: bring the branch up to date with dev',
          'The Run branch already has dev (commit ddddddd): nothing was changed',
          'Follow-up 2 ended: already up to date',
        ]);
      });

      it('leaves the Run as it was, with the error, when the integration branch cannot be fetched', async () => {
        const run = bringUpPayload('x');
        const api = new RecordingApi([run]);
        const runner = new Recorder();
        const updates = new FakeBranchUpdates();
        updates.startFailure = new PreparationFailedError(
          'The integration branch dev could not be fetched.',
        );
        startWorker(api, runner, undefined, { branchUpdates: updates });

        await until(() => stateReports(api).length === 1);

        expect(stateReports(api)[0]).toEqual({
          state: 'succeeded',
          unchanged: true,
          unchangedDetail:
            'The integration branch dev could not be fetched. Nothing was changed: the Run is as it was before the request.',
        });
        expect(runner.resumed).toEqual([]);
        expect(updates.calls).toEqual([STALE, 'start']);
      });

      it('aborts the merge and fails the Run when the agent leaves conflicts, pushing nothing', async () => {
        const run = bringUpPayload('x');
        const api = new RecordingApi([run]);
        const updates = new FakeBranchUpdates();
        updates.start_ = {
          outcome: 'conflicts',
          commit: MERGED,
          baseCommit: BASE,
          files: ['a.ts'],
          moreFiles: 0,
        };
        updates.completeFailure = new MergeIncompleteError(['a.ts']);
        const deliveries = new FakeDeliveries();
        startWorker(api, new Recorder(), undefined, deliveries, { branchUpdates: updates });

        await until(() => stateReports(api).length === 2);

        expect(updates.calls).toEqual([STALE, 'start', `complete ${MERGED}`, `abort ${BASE}`]);
        expect(stateReports(api)[1]).toMatchObject({
          state: 'failed',
          failure: {
            code: 'agent_failed',
            detail: expect.stringContaining('these conflicts: a.ts'),
          },
        });
        expect(deliveries.calls).toEqual([]);
      });

      it('undoes the update when the agent fails or the step is stopped', async () => {
        const failing = bringUpPayload('x');
        const api = new RecordingApi([failing]);
        const runner: Runner = {
          // eslint-disable-next-line require-yield
          async *start(): RunStep {
            throw new Error('not used');
          },
          // eslint-disable-next-line require-yield
          async *resume(): RunStep {
            throw new AgentFailedError('The agent crashed.');
          },
        };
        const updates = new FakeBranchUpdates();
        startWorker(api, runner, undefined, { branchUpdates: updates });
        await until(() => stateReports(api).length === 2);
        expect(updates.calls).toEqual([STALE, 'start', `abort ${BASE}`]);
        await worker?.stop();

        const cancelled = bringUpPayload('x', { runId: payload('x', 2).runId });
        const slow = new RecordingApi([cancelled]);
        slow.cancelRequested = true;
        const stopped = new FakeBranchUpdates();
        const hanging: Runner = {
          // eslint-disable-next-line require-yield
          async *start(): RunStep {
            throw new Error('not used');
          },
          // eslint-disable-next-line require-yield
          async *resume(input: ResumeRunStepInput): RunStep {
            await new Promise((_resolve, reject) =>
              input.signal.addEventListener('abort', () => reject(input.signal.reason)),
            );
            return { outcome: 'done', summary: 'never' };
          },
        };
        startWorker(slow, hanging, undefined, { branchUpdates: stopped });
        await until(() =>
          stateReports(slow).some((report) => (report as { state?: string }).state === 'cancelled'),
        );
        expect(stopped.calls).toContain(`abort ${BASE}`);
      });

      it('keeps the merge for the retry when only the delivery failed', async () => {
        const run = bringUpPayload('x');
        const api = new RecordingApi([run]);
        const updates = new FakeBranchUpdates();
        const deliveries = new FakeDeliveries();
        deliveries.deliverFailure = new DeliveryFailedError('Pushing was refused.');
        startWorker(api, new Recorder(), undefined, deliveries, { branchUpdates: updates });

        await until(() => stateReports(api).length === 2);

        expect(stateReports(api)[1]).toMatchObject({
          state: 'failed',
          failure: { code: 'delivery_failed' },
        });
        expect(updates.calls).toEqual([STALE, 'start', `complete ${MERGED}`]);
      });

      it('keeps the merge open when the usage limit pauses the part', async () => {
        const run = bringUpPayload('x');
        const api = new RecordingApi([run]);
        const updates = new FakeBranchUpdates();
        const limited: Runner = {
          // eslint-disable-next-line require-yield
          async *start(): RunStep {
            throw new Error('not used');
          },
          // eslint-disable-next-line require-yield
          async *resume(input: ResumeRunStepInput): RunStep {
            throw new UsageLimitError('The usage limit was reached.', input.sessionRef);
          },
        };
        startWorker(api, limited, undefined, { branchUpdates: updates });

        await until(() => stateReports(api).length === 2);

        expect(updates.calls).toEqual([STALE, 'start']);
        expect(stateReports(api)[1]).toMatchObject({
          state: 'failed',
          failure: { code: 'usage_limit' },
        });
      });

      it('goes on with the part on a later claim: no stale abort, no second start, Studio gives the expected commit', async () => {
        const run = bringUpPayload('Option A', {
          resumeReason: 'answer',
          updateBase: BASE,
          updateTip: MERGED,
        });
        const api = new RecordingApi([run]);
        const updates = new FakeBranchUpdates();
        updates.completion = { mergedCommit: MERGED, completed: true };
        startWorker(api, new Recorder(), undefined, { branchUpdates: updates });

        await until(() => stateReports(api).length === 2);

        expect(updates.calls).toEqual([`complete ${MERGED}`]);
        expect(stateReports(api)[1]).toMatchObject({ state: 'succeeded' });
      });

      it('undoes the update to the base Studio kept when a later claim of the part fails', async () => {
        const run = bringUpPayload('Option A', {
          resumeReason: 'answer',
          updateBase: BASE,
          updateTip: MERGED,
        });
        const api = new RecordingApi([run]);
        const updates = new FakeBranchUpdates();
        updates.completeFailure = new MergeIncompleteError([]);
        startWorker(api, new Recorder(), undefined, { branchUpdates: updates });

        await until(() => stateReports(api).length === 2);

        expect(updates.calls).toEqual([`complete ${MERGED}`, `abort ${BASE}`]);
        expect(stateReports(api)[1]).toMatchObject({
          state: 'failed',
          failure: { code: 'agent_failed' },
        });
      });

      it('counts the Run own changes from the integration commit it merged', async () => {
        const run = bringUpPayload('x', { mergedIntegrationCommit: 'e'.repeat(40) });
        const api = new RecordingApi([run]);
        const workingCopies = new FakeWorkingCopies();
        startWorker(api, new Recorder(), workingCopies, {
          branchUpdates: new FakeBranchUpdates(),
        });

        await until(() => stateReports(api).length === 2);

        expect(workingCopies.located).toEqual([run.runId]);
      });

      it('resets the branch to where an earlier update began when that part never succeeded', async () => {
        const run = bringUpPayload('More', {
          resumeReason: 'follow_up',
          bringUpToDate: undefined,
          pendingUpdate: { baseCommit: BASE },
        });
        const api = new RecordingApi([run]);
        const updates = new FakeBranchUpdates();
        updates.undoes = true;
        startWorker(api, new Recorder(), undefined, { branchUpdates: updates });

        await until(() => stateReports(api).length === 2);

        expect(updates.calls).toEqual([`abort ${BASE}`]);
      });

      it('never resets on a later claim of the same part, nor for a delivery retry', async () => {
        const run = bringUpPayload('Option A', {
          resumeReason: 'answer',
          pendingUpdate: { baseCommit: BASE },
        });
        const api = new RecordingApi([run]);
        const updates = new FakeBranchUpdates();
        updates.completion = { mergedCommit: MERGED, completed: true };
        startWorker(api, new Recorder(), undefined, { branchUpdates: updates });

        await until(() => stateReports(api).length === 2);

        expect(updates.calls).toEqual(['complete -']);
      });

      it('aborts a merge an earlier part left open before a plain Follow-up starts, never mid-part', async () => {
        const run = bringUpPayload('More', {
          resumeReason: 'follow_up',
          bringUpToDate: undefined,
        });
        const api = new RecordingApi([run]);
        const updates = new FakeBranchUpdates();
        updates.undoes = true;
        startWorker(api, new Recorder(), undefined, { branchUpdates: updates });

        await until(() => stateReports(api).length === 2);

        expect(updates.calls).toEqual([STALE]);
        expect(notices(api)).toEqual([
          'What an earlier update left in the working copy was undone',
          'Follow-up 2 started',
          'Follow-up 2 ended: done',
        ]);
      });
    });

    describe('a Follow-up', () => {
      const followUpPayload = (text: string, overrides: Partial<RunPayload> = {}): RunPayload => ({
        ...resumePayload('Add a feature', 3),
        answer: text,
        resumeReason: 'follow_up',
        followUpNumber: 2,
        stepsBeforePart: 3,
        pullRequestNumber: 7,
        ...overrides,
      });
      const notices = (api: RecordingApi) =>
        api
          .events()
          .filter((event) => event.kind === 'notice')
          .map((event) => event.text);

      it('hands the runner the Follow-up text and its reason, and marks its start and end in the log', async () => {
        const run = followUpPayload('Also handle the empty list.');
        const api = new RecordingApi([run]);
        const runner = new RecordingRunner();
        startWorker(api, runner);

        await until(() => api.reports().length === 3);

        expect(runner.resumed[0]).toMatchObject({
          answer: 'Also handle the empty list.',
          reason: 'follow_up',
          sessionRef: run.sessionRef,
        });
        const kinds = api.events().map((event) => [event.kind, event.text]);
        expect(kinds[0]).toEqual(['notice', 'Follow-up 2 started']);
        expect(kinds[1]?.[0]).toBe('step_started');
        expect(kinds.at(-1)).toEqual(['notice', 'Follow-up 2 ended: done']);
        expect(api.reports()[1]?.[2]).toMatchObject({ index: 4, kind: 'resume' });
      });

      describe('the pull request state', () => {
        it.each([
          ['merged', 'was merged on GitHub'],
          ['closed', 'was closed on GitHub'],
          ['missing', 'was not found on GitHub'],
        ] as const)(
          'does not start the agent for a pull request that is %s: the Run fails with the reason',
          async (state, words) => {
            const run = followUpPayload('Also handle the empty list.');
            const api = new RecordingApi([run]);
            const runner = new RecordingRunner();
            const workingCopies = new FakeWorkingCopies();
            const lookups = new FakeLookups();
            lookups.state = state;
            startWorker(api, runner, workingCopies, { lookups });

            await until(() => api.reports().length === 1);

            expect(lookups.asked).toEqual([run.runId]);
            expect(runner.resumed).toEqual([]);
            expect(workingCopies.located).toEqual([]);
            expect(api.reports()[0]?.[2]).toMatchObject({
              state: 'failed',
              failure: {
                code: 'preparation_failed',
                detail: expect.stringContaining(words),
              },
            });
            expect(api.reports()[0]?.[2]).toMatchObject({ pullRequestState: state });
            expect(notices(api)).toEqual([
              `Follow-up 2 not started: the pull request is ${state === 'missing' ? 'not found' : state}`,
              'Follow-up 2 ended: failed',
            ]);
          },
        );

        it.each(['open', 'draft', 'unknown'] as const)(
          'starts the agent when the pull request is %s',
          async (state) => {
            const run = followUpPayload('Also handle the empty list.');
            const api = new RecordingApi([run]);
            const runner = new RecordingRunner();
            const lookups = new FakeLookups();
            lookups.state = state;
            startWorker(api, runner, undefined, { lookups });

            await until(() => api.reports().length === 3);

            expect(runner.resumed).toHaveLength(1);
            expect(api.reports()[2]?.[2]).toMatchObject({ state: 'succeeded' });
          },
        );

        it('reads the state for a Follow-up only, not for an answer', async () => {
          const run = resumePayload('[fake:question]');
          const api = new RecordingApi([run]);
          const lookups = new FakeLookups();
          startWorker(api, undefined, undefined, { lookups });

          await until(() => api.reports().length >= 2);

          expect(lookups.asked).toEqual([]);
        });
      });

      it('marks the end of a Follow-up that failed, but not of one that asks', async () => {
        const failing = followUpPayload('[fake:fail]');
        const api = new RecordingApi([failing]);
        startWorker(api);
        await until(() => api.reports().length === 2);
        expect(notices(api)).toEqual(['Follow-up 2 started', 'Follow-up 2 ended: failed']);
        await worker?.stop();

        const asking = followUpPayload('[fake:question]', { runId: payload('x', 2).runId });
        const askingApi = new RecordingApi([
          { ...asking, sessionRef: fakeSessionRef(asking.runId) },
        ]);
        startWorker(askingApi);
        await until(() => askingApi.reports().length === 3);
        expect(askingApi.reports()[2]?.[2]).toEqual({ state: 'waiting_for_operator' });
        expect(notices(askingApi)).toEqual(['Follow-up 2 started']);
      });

      it('marks the end when an answer inside the Follow-up finishes it', async () => {
        const { followUpNumber, ...rest } = followUpPayload('x');
        const run: RunPayload = { ...rest, followUpNumber, resumeReason: 'answer', answer: 'A' };
        const api = new RecordingApi([run]);
        startWorker(api, new RecordingRunner());

        await until(() => api.reports().length === 3);

        expect(notices(api)).toEqual(['Follow-up 2 ended: done']);
      });

      it('gives each part its own allowance of Run steps', async () => {
        // Three steps before the Follow-up, ten allowed per part: step 13 may start, 14 not.
        const allowed = followUpPayload('More', { completedSteps: 12 });
        const api = new RecordingApi([allowed]);
        startWorker(api, new RecordingRunner());
        await until(() => api.reports().length === 3);
        expect(api.reports()[1]?.[2]).toMatchObject({ index: 13 });
        await worker?.stop();

        const beyond = followUpPayload('More', { completedSteps: 13 });
        const refusedApi = new RecordingApi([beyond]);
        const workingCopies = new FakeWorkingCopies();
        startWorker(refusedApi, new RecordingRunner(), workingCopies);
        await until(() => refusedApi.reports().length === 1);
        expect(refusedApi.reports()[0]?.[2]).toMatchObject({
          state: 'failed',
          failure: { code: 'step_limit' },
        });
        expect(workingCopies.located).toEqual([]);
      });

      it('pauses a Follow-up at the usage limit and says so when it resumes', async () => {
        class LimitedRunner extends RecordingRunner {
          // eslint-disable-next-line require-yield
          override async *resume(input: ResumeRunStepInput): RunStep {
            this.resumed.push(input);
            throw new UsageLimitError('The usage limit was reached.', input.sessionRef);
          }
        }
        const api = new RecordingApi([followUpPayload('More')]);
        const deliveries = new FakeDeliveries();
        startWorker(api, new LimitedRunner(), new FakeWorkingCopies(), deliveries);
        await until(() => api.reports().length === 2);
        expect(notices(api)).toEqual(['Follow-up 2 started', 'Follow-up 2 paused: usage limit']);
        expect(api.reports()[1]?.[2]).toMatchObject({ failure: { code: 'usage_limit' } });
        await worker?.stop();

        const resumed = followUpPayload('Continue where you stopped.', {
          resumeReason: 'usage_limit',
        });
        const resumedApi = new RecordingApi([resumed]);
        startWorker(resumedApi, new RecordingRunner());
        await until(() => resumedApi.reports().length === 3);
        expect(notices(resumedApi)).toEqual(['Follow-up 2 resumed', 'Follow-up 2 ended: done']);
      });

      it.each([
        ['fails', '[fake:fail]'],
        ['crashes', '[fake:crash]'],
      ])('never delivers a Follow-up that %s: nothing is pushed', async (_what, text) => {
        const run = followUpPayload(text, { sessionRef: fakeSessionRef(payload('x', 9).runId) });
        const own = { ...run, runId: payload('x', 9).runId };
        const api = new RecordingApi([own]);
        const deliveries = new FakeDeliveries();
        startWorker(api, undefined, new FakeWorkingCopies(), deliveries);
        await until(() => api.reports().length === 2);
        expect(api.reports()[1]?.[2]).toMatchObject({ state: 'failed' });
        expect(deliveries.calls.map(([call]) => call)).not.toContain('deliver');
        expect(deliveries.calls.map(([call]) => call)).not.toContain('commit');
      });

      it('delivers a Follow-up of a Run without a pull request yet as a first delivery', async () => {
        const run = followUpPayload('More', { pullRequestNumber: undefined });
        const api = new RecordingApi([run]);
        const deliveries = new FakeDeliveries();
        const seen: RunPayload[] = [];
        const recording: DeliveryPort = {
          commit: (prepared, payload, result) => deliveries.commit(prepared, payload, result),
          keep: (prepared, result) => deliveries.keep(prepared, result),
          deliver: (prepared, payload, result, signal) => {
            seen.push(payload);
            return deliveries.deliver(prepared, payload, result, signal);
          },
          locate: (payload) => deliveries.locate(payload),
        };
        startWorker(api, new RecordingRunner(), new FakeWorkingCopies(), recording);
        await until(() => api.reports().length === 3);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.pullRequestNumber).toBeUndefined();
        expect(api.reports()[2]?.[2]).toMatchObject({ state: 'succeeded', delivery: DELIVERED });
      });

      it('reports the pushed commit of a delivery that failed after its push', async () => {
        const api = new RecordingApi([followUpPayload('More')]);
        const deliveries = new FakeDeliveries();
        deliveries.deliverFailure = new DeliveryFailedError(
          'Updating the pull request failed: GitHub answered 403.',
          true,
          'a'.repeat(40),
        );
        startWorker(api, new RecordingRunner(), new FakeWorkingCopies(), deliveries);
        await until(() => api.reports().length === 3);
        expect(api.reports()[2]?.[2]).toMatchObject({
          state: 'failed',
          failure: { code: 'delivery_failed' },
          pushedCommit: 'a'.repeat(40),
        });
      });

      it('passes the claim to the Working copy, which replaces the Environment file', async () => {
        const run = followUpPayload('More', {
          replaceEnvironmentFile: true,
          studioPaths: ['.env'],
          environmentFile: { path: '.env', content: 'A=1' },
        });
        const api = new RecordingApi([run]);
        const workingCopies = new FakeWorkingCopies();
        const located: RunPayload[] = [];
        class Recording extends FakeWorkingCopies {
          override async locate(payload: RunPayload): Promise<PreparedRun> {
            located.push(payload);
            return workingCopies.locate(payload);
          }
        }
        const runner = new RecordingRunner();
        startWorker(api, runner, new Recording());
        await until(() => api.reports().length === 3);
        expect(located[0]).toMatchObject({ replaceEnvironmentFile: true });
        expect(runner.resumed[0]?.run).not.toHaveProperty('environmentFile');
      });
    });

    it('checks the provider gate before it resumes (provider_disabled)', async () => {
      const run = resumePayload('[fake:question]');
      const api = new RecordingApi([run]);
      const workingCopies = new FakeWorkingCopies();
      startWorker(api, undefined, workingCopies, {
        gate: {
          assertEnabled: () => {
            throw new ProviderDisabledError('codex');
          },
        },
      });

      await until(() => api.reports().length === 1);

      expect(api.reports()[0]?.[2]).toMatchObject({ failure: { code: 'provider_disabled' } });
      expect(workingCopies.located).toEqual([]);
    });
  });
});

describe('the agent folder of a Run', () => {
  const reviewer = (run: RunPayload): RunPayload => ({
    ...run,
    agent: {
      ...run.agent,
      name: 'reviewer',
      source: 'definitions',
      commit: 'c'.repeat(40),
      instructions: 'Review.',
    },
  });

  /** Records every rebuild, in order with the runner's steps. */
  class RecordingFolders implements AgentFolderPort {
    readonly events: string[] = [];
    failure: Error | undefined;
    /** What `place` answers: files or none. */
    files = 2;

    async place(run: RunPayload, dir: string) {
      this.events.push(`place ${run.kind} ${dir}`);
      if (this.failure) throw this.failure;
      return this.files === 0 ? null : { dir, files: this.files };
    }
  }

  const recordingRunner = (events: string[], seen: StartRunStepInput[] = []): Runner => ({
    // eslint-disable-next-line require-yield
    async *start(input): RunStep {
      events.push('start');
      seen.push(input);
      return { outcome: 'done', summary: 'Done.' };
    },
    // eslint-disable-next-line require-yield
    async *resume(input): RunStep {
      events.push('resume');
      seen.push(input);
      return { outcome: 'done', summary: 'Done.' };
    },
  });

  it('is rebuilt before the first step and handed to the runner as the folder to name', async () => {
    const run = reviewer(payload('Add a feature'));
    const api = new RecordingApi([run]);
    const folders = new RecordingFolders();
    const seen: StartRunStepInput[] = [];
    startWorker(api, recordingRunner(folders.events, seen), undefined, { agentFolders: folders });

    await until(() => api.reports().length === 3);

    expect(folders.events).toEqual([`place start /data/runs/${run.runId}/agent`, 'start']);
    expect(seen[0]?.workspace.agentFolder).toBe(`/data/runs/${run.runId}/agent`);
  });

  it('is rebuilt again before a resumed step, whatever resumes it', async () => {
    const run = reviewer({
      ...payload('Add a feature'),
      kind: 'resume',
      runBranch: REPORT.runBranch,
      sessionRef: fakeSessionRef(payload('Add a feature').runId),
      answer: 'Option A',
      resumeReason: 'follow_up',
      followUpNumber: 1,
      nextSeq: 10,
      completedSteps: 1,
    });
    const api = new RecordingApi([run]);
    const folders = new RecordingFolders();
    startWorker(api, recordingRunner(folders.events), undefined, { agentFolders: folders });

    await until(() => api.reports().length === 3);

    expect(folders.events).toEqual([`place resume /data/runs/${run.runId}/agent`, 'resume']);
  });

  it('is not named to the runner when the agent has no files', async () => {
    const run = reviewer(payload('Add a feature'));
    const api = new RecordingApi([run]);
    const folders = new RecordingFolders();
    folders.files = 0;
    const seen: StartRunStepInput[] = [];
    startWorker(api, recordingRunner(folders.events, seen), undefined, { agentFolders: folders });

    await until(() => api.reports().length === 3);

    expect(seen[0]?.workspace).toEqual({
      repoDir: `/data/runs/${run.runId}/repo`,
      runDir: `/data/runs/${run.runId}`,
      env: { COMPOSE_PROJECT_NAME: 'studio-run-0b8e5c2d1f3a' },
    });
    expect(seen[0]?.workspace).not.toHaveProperty('agentFolder');
  });

  it.each([
    [new AgentFolderUnavailableError(), 'agent_folder_unavailable'],
    [new AgentFolderTransientError(), 'preparation_failed'],
    [
      new AgentFolderInvalidError('The agent files fail the validation: nested_git (a/.git).'),
      'agent_folder_invalid',
    ],
  ])('fails the Run as %s before any agent starts', async (error, code) => {
    const run = reviewer(payload('Add a feature'));
    const api = new RecordingApi([run]);
    const folders = new RecordingFolders();
    folders.failure = error;
    startWorker(api, recordingRunner(folders.events), undefined, { agentFolders: folders });

    await until(() => api.reports().length === 1);

    expect(api.reports()).toHaveLength(1);
    expect(api.reports()[0]).toEqual([
      'state',
      run.runId,
      { state: 'failed', failure: { code, detail: error.message }, workingCopy: REPORT },
    ]);
    expect(folders.events).toEqual([`place start /data/runs/${run.runId}/agent`]);
  });

  it('is left alone for the built-in Default agent: the worker has nothing to rebuild', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    const folders = new RecordingFolders();
    startWorker(api, recordingRunner(folders.events), undefined, { agentFolders: folders });

    await until(() => api.reports().length === 3);

    // Rebuilding is asked for every Run; the folder itself answers "none" for a built-in agent.
    expect(folders.events[0]).toBe(`place start /data/runs/${run.runId}/agent`);
  });
});

describe('the processes of a step with agent files', () => {
  it('starts no process whose command, argument or working directory is in the agent folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-step-'));
    try {
      const runDir = join(root, 'run');
      mkdirSync(join(runDir, 'repo'), { recursive: true });
      const marker = join(root, 'ran');
      const base = payload('Add a feature');
      const run: RunPayload = {
        ...base,
        agent: {
          ...base.agent,
          name: 'reviewer',
          source: 'definitions',
          commit: 'c'.repeat(40),
          instructions: 'Review.',
        },
      };
      class TmpCopies extends FakeWorkingCopies {
        override async prepare(claimed: RunPayload): Promise<PreparedRun> {
          return { ...(await super.prepare(claimed)), runDir, repoDir: join(runDir, 'repo') };
        }
      }
      const folders = new AgentFolders({
        api: {
          agentFolder: async () => ({
            commit: 'c'.repeat(40),
            files: [
              {
                path: 'run.sh',
                executable: true,
                contentBase64: Buffer.from(`#!/bin/sh\ntouch '${marker}'\n`).toString('base64'),
              },
              {
                path: 'tool.py',
                executable: true,
                contentBase64: Buffer.from('x').toString('base64'),
              },
            ],
          }),
        },
      });
      const spawned = vi.mocked(spawn);
      spawned.mockClear();
      // The spy sees every process this module graph starts: one started on purpose proves it.
      await runProcess({
        binary: process.execPath,
        args: ['-e', '0'],
        cwd: root,
        env: {},
        timeoutMs: 10_000,
      });
      expect(spawned).toHaveBeenCalledTimes(1);
      spawned.mockClear();
      const api = new RecordingApi([run]);
      const fake = new FakeRunner({ slowMs: 10 });
      // A step that starts one process of its own, as a CLI runner does, then plays the fake step.
      const starting: Runner = {
        async *start(input): RunStep {
          await runProcess({
            binary: process.execPath,
            args: ['-e', '0'],
            cwd: input.workspace.repoDir,
            env: {},
            timeoutMs: 10_000,
          });
          return yield* fake.start(input);
        },
        resume: (input) => fake.resume(input),
      };
      startWorker(api, starting, new TmpCopies(), { agentFolders: folders });

      await until(() => api.reports().length === 3);

      // The step's own processes went through the spy, so the check below is not vacuous.
      expect(spawned.mock.calls.length).toBeGreaterThan(0);
      const agentDir = join(runDir, 'agent');
      expect(readdirSync(agentDir).sort()).toEqual(['run.sh', 'tool.py']);
      expect(existsSync(marker)).toBe(false);
      for (const [command, args, options] of spawned.mock.calls) {
        const started = [String(command), ...(args ?? []), String(options?.cwd ?? '')];
        for (const part of started) expect(part.includes(agentDir), part).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the skills of a Run', () => {
  const NAMES = [
    { name: 'lint', description: 'Lints the code.' },
    { name: 'notes', description: 'Writes notes.' },
  ];
  const withSkills = (run: RunPayload): RunPayload => ({
    ...run,
    agent: {
      ...run.agent,
      name: 'reviewer',
      source: 'definitions',
      commit: 'c'.repeat(40),
      instructions: 'Review.',
    },
    skills: NAMES,
  });

  /** Records every rebuild, in order with the runner's steps. */
  class RecordingSkills implements RunSkillsPort {
    readonly events: string[] = [];
    failure: Error | undefined;
    omitted: string[] = [];
    /** What `place` answers: both skills, or none. */
    placed = true;

    async place(run: RunPayload, dir: string): Promise<PlacedSkills | null> {
      this.events.push(`place ${run.kind} ${dir}`);
      if (this.failure) throw this.failure;
      if (!this.placed) return null;
      return {
        dir,
        skills: NAMES.map((skill) => ({ ...skill, entryFile: `${dir}/${skill.name}/SKILL.md` })),
        omitted: this.omitted,
      };
    }
  }

  const recordingRunner = (events: string[], seen: StartRunStepInput[] = []): Runner => ({
    // eslint-disable-next-line require-yield
    async *start(input): RunStep {
      events.push('start');
      seen.push(input);
      return { outcome: 'done', summary: 'Done.' };
    },
    // eslint-disable-next-line require-yield
    async *resume(input): RunStep {
      events.push('resume');
      seen.push(input);
      return { outcome: 'done', summary: 'Done.' };
    },
  });

  const notices = (api: RecordingApi) =>
    api
      .events()
      .filter((event) => event.kind === 'notice')
      .map((event) => event.text);

  it('are rebuilt before the first step and handed to the runner with their entry files', async () => {
    const run = withSkills(payload('Add a feature'));
    const api = new RecordingApi([run]);
    const skills = new RecordingSkills();
    const seen: StartRunStepInput[] = [];
    startWorker(api, recordingRunner(skills.events, seen), undefined, { skills });

    await until(() => api.reports().length === 3);

    expect(skills.events).toEqual([`place start /data/runs/${run.runId}/skills`, 'start']);
    expect(seen[0]?.workspace.skills).toEqual([
      {
        name: 'lint',
        description: 'Lints the code.',
        entryFile: `/data/runs/${run.runId}/skills/lint/SKILL.md`,
      },
      {
        name: 'notes',
        description: 'Writes notes.',
        entryFile: `/data/runs/${run.runId}/skills/notes/SKILL.md`,
      },
    ]);
  });

  it('are rebuilt again before a resumed step, whatever resumes it', async () => {
    const run = withSkills({
      ...payload('Add a feature'),
      kind: 'resume',
      runBranch: REPORT.runBranch,
      sessionRef: fakeSessionRef(payload('Add a feature').runId),
      answer: 'Option A',
      resumeReason: 'follow_up',
      followUpNumber: 1,
      nextSeq: 10,
      completedSteps: 1,
    });
    const api = new RecordingApi([run]);
    const skills = new RecordingSkills();
    startWorker(api, recordingRunner(skills.events), undefined, { skills });

    await until(() => api.reports().length === 3);

    expect(skills.events).toEqual([`place resume /data/runs/${run.runId}/skills`, 'resume']);
  });

  it('are not named to the runner when the Run has none', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    const skills = new RecordingSkills();
    skills.placed = false;
    const seen: StartRunStepInput[] = [];
    startWorker(api, recordingRunner(skills.events, seen), undefined, { skills });

    await until(() => api.reports().length === 3);

    expect(seen[0]?.workspace).toEqual({
      repoDir: `/data/runs/${run.runId}/repo`,
      runDir: `/data/runs/${run.runId}`,
      env: { COMPOSE_PROJECT_NAME: 'studio-run-0b8e5c2d1f3a' },
    });
    expect(seen[0]?.workspace).not.toHaveProperty('skills');
    expect(notices(api)).toEqual([]);
  });

  it('are named in the Run log by the ones left out for the budget; the runner names the rest', async () => {
    const run = withSkills(payload('Add a feature'));
    const api = new RecordingApi([run]);
    const skills = new RecordingSkills();
    skills.omitted = ['big'];
    startWorker(api, recordingRunner(skills.events), undefined, { skills });

    await until(() => api.reports().length === 3);

    expect(notices(api)).toEqual(['Skills left out because their files pass 20 MiB in total: big']);
    expect(notices(api).join(' ')).not.toMatch(/Lints|Writes|SKILL\.md/);
  });

  it('fail the Run as skills_unusable before any agent starts', async () => {
    const run = withSkills(payload('Add a feature'));
    const api = new RecordingApi([run]);
    const skills = new RecordingSkills();
    const error = new SkillsUnusableError(
      'The skill lint fails the validation: shell_line (lint/more.md).',
    );
    skills.failure = error;
    startWorker(api, recordingRunner(skills.events), undefined, { skills });

    await until(() => api.reports().length === 1);

    expect(api.reports()).toHaveLength(1);
    expect(api.reports()[0]).toEqual([
      'state',
      run.runId,
      {
        state: 'failed',
        failure: { code: 'skills_unusable', detail: error.detail },
        workingCopy: REPORT,
      },
    ]);
    expect(skills.events).toEqual([`place start /data/runs/${run.runId}/skills`]);
  });

  it('are fetched with the Run id only, and an outage of the route fails the Run as preparation_failed', async () => {
    const run = withSkills(payload('Add a feature'));
    const api = new RecordingApi([run]);
    const asked: string[] = [];
    const real = new RunSkills({
      api: {
        runSkills: async (runId) => {
          asked.push(runId);
          throw new StudioApiError(503, '/api/worker/runs/x/skills');
        },
      },
    });
    startWorker(api, recordingRunner([]), undefined, { skills: real });

    await until(() => api.reports().length === 1);

    expect(asked).toEqual([run.runId]);
    expect(api.reports()[0]?.[2]).toMatchObject({
      state: 'failed',
      failure: { code: 'preparation_failed' },
    });
  });
});

describe('the processes of a step with skills', () => {
  it('starts no process whose command, argument or working directory is in the skills folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-step-skills-'));
    try {
      const runDir = join(root, 'run');
      mkdirSync(join(runDir, 'repo'), { recursive: true });
      const marker = join(root, 'ran');
      const base = payload('Add a feature');
      const run: RunPayload = {
        ...base,
        agent: {
          ...base.agent,
          name: 'reviewer',
          source: 'definitions',
          commit: 'c'.repeat(40),
          instructions: 'Review.',
        },
        skills: [{ name: 'lint', description: 'Does lint' }],
      };
      class TmpCopies extends FakeWorkingCopies {
        override async prepare(claimed: RunPayload): Promise<PreparedRun> {
          return { ...(await super.prepare(claimed)), runDir, repoDir: join(runDir, 'repo') };
        }
      }
      const b64 = (text: string) => Buffer.from(text).toString('base64');
      const skills = new RunSkills({
        api: {
          runSkills: async () => ({
            commit: 'c'.repeat(40),
            skills: [
              {
                name: 'lint',
                files: [
                  {
                    path: 'SKILL.md',
                    executable: false,
                    contentBase64: b64('---\nname: lint\ndescription: Does lint\n---\nGo.\n'),
                  },
                  {
                    path: 'run.sh',
                    executable: true,
                    contentBase64: b64(`#!/bin/sh\ntouch '${marker}'\n`),
                  },
                ],
              },
            ],
            omitted: [],
          }),
        },
      });
      const spawned = vi.mocked(spawn);
      spawned.mockClear();
      const api = new RecordingApi([run]);
      const fake = new FakeRunner({ slowMs: 10 });
      // A step that starts one process of its own, as a CLI runner does, then plays the fake step.
      const starting: Runner = {
        async *start(input): RunStep {
          await runProcess({
            binary: process.execPath,
            args: ['-e', '0'],
            cwd: input.workspace.repoDir,
            env: {},
            timeoutMs: 10_000,
          });
          return yield* fake.start(input);
        },
        resume: (input) => fake.resume(input),
      };
      startWorker(api, starting, new TmpCopies(), { skills });

      await until(() => api.reports().length === 3);

      expect(spawned.mock.calls.length).toBeGreaterThan(0);
      const skillsDir = join(runDir, 'skills');
      expect(readdirSync(join(skillsDir, 'lint')).sort()).toEqual(['SKILL.md', 'run.sh']);
      expect(existsSync(marker)).toBe(false);
      for (const [command, args, options] of spawned.mock.calls) {
        const started = [String(command), ...(args ?? []), String(options?.cwd ?? '')];
        for (const part of started) expect(part.includes(skillsDir), part).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AgentWorker: a Run of a Workflow', () => {
  const PROVIDERS = ['claude_code', 'codex'] as const;

  const phaseRun = (
    provider: (typeof PROVIDERS)[number],
    claim: Partial<RunPayload> & { phase: NonNullable<RunPayload['phase']> },
  ): RunPayload => ({
    ...payload('Add a feature'),
    provider,
    ...agentFields(provider),
    ...claim,
  });

  const next = (
    provider: (typeof PROVIDERS)[number],
    phase: NonNullable<RunPayload['phase']>,
    more: Partial<RunPayload> = {},
  ): RunPayload =>
    phaseRun(provider, {
      kind: 'next_phase',
      runBranch: REPORT.runBranch,
      nextSeq: 5,
      completedSteps: 1,
      stepsBeforePart: 1,
      phase,
      ...more,
    });

  const messages = (api: RecordingApi) => api.events().map((event) => event.text);

  describe.each(PROVIDERS)('with %s', (provider) => {
    it('hands the Working copy on after a Phase that is not the last: nothing is committed or delivered, its result is kept', async () => {
      const run = phaseRun(provider, {
        phase: { position: 0, itemId: 'build', count: 2, final: false },
      });
      const api = new RecordingApi([run]);
      const deliveries = new FakeDeliveries();
      startWorker(api, undefined, undefined, deliveries);

      await until(() => api.reportsWithDiffs().length === 3);
      await delay(30);

      // Kept, so that a delivery after a Checkpoint can write the pull request from it.
      expect(deliveries.calls.map(([step]) => step)).toEqual(['keep']);
      // The diffs go before the step that ends the Phase, which releases the Run; no state follows.
      expect(api.reportsWithDiffs().map(([kind]) => kind)).toEqual(['state', 'diff', 'step']);
      expect(api.reports().map(([kind]) => kind)).toEqual(['state', 'step']);
      expect(messages(api)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^Phase build \(1\/2\): agent default-.+, (Claude Code|Codex)$/),
          'Phase build (1/2) ended: done',
        ]),
      );
    });

    it('starts the next Phase in the kept Working copy, with a session of its own, and delivers once after the last', async () => {
      const run = next(provider, {
        position: 1,
        itemId: 'polish',
        count: 2,
        final: true,
        previous: { itemId: 'build', agent: 'builder', summary: 'Built the endpoint.' },
      });
      const api = new RecordingApi([run]);
      const deliveries = new FakeDeliveries();
      const copies = new FakeWorkingCopies();
      startWorker(api, undefined, copies, deliveries);

      await until(() => api.reports().length === 3);

      expect(copies.located).toEqual([run.runId]);
      expect(copies.prepared).toEqual([]);
      expect(api.reports()[1]).toEqual([
        'step',
        run.runId,
        {
          index: 2,
          kind: 'start',
          result: expect.objectContaining({
            outcome: 'done',
            sessionRef: fakeSessionRef(run.runId, 1),
          }),
          workingCopy: REPORT,
        },
      ]);
      expect(api.reports()[2]).toEqual([
        'state',
        run.runId,
        { state: 'succeeded', delivery: DELIVERED },
      ]);
      expect(deliveries.calls.map(([step]) => step)).toEqual(['commit', 'deliver']);
      expect(messages(api)).toEqual(
        expect.arrayContaining([
          'fake runner: told by phase build: Built the endpoint.',
          'Phase polish (2/2) ended: done',
        ]),
      );
    });

    it('resumes the session the Phase had in an earlier round', async () => {
      const run = next(
        provider,
        { position: 1, itemId: 'polish', count: 2, final: true },
        {
          sessionRef: fakeSessionRef('0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a11', 1),
          answer: 'Add a test too.',
          resumeReason: 'follow_up',
          followUpNumber: 1,
        },
      );
      const api = new RecordingApi([run]);
      startWorker(api);

      await until(() => api.reports().length === 3);

      expect(api.reports()[1]?.[2]).toMatchObject({
        kind: 'resume',
        result: { sessionRef: fakeSessionRef(run.runId, 1) },
      });
    });

    it('does not start a Phase whose Provider was switched off, saying which Phase it was', async () => {
      const run = next(provider, { position: 1, itemId: 'polish', count: 2, final: true });
      const api = new RecordingApi([run]);
      const copies = new FakeWorkingCopies();
      const runner = new FakeRunner();
      const started = vi.spyOn(runner, 'start');
      startWorker(api, runner, copies, {
        gate: {
          assertEnabled: () => {
            throw new ProviderDisabledError(provider);
          },
        },
      });

      await until(() => api.reports().length === 1);

      expect(api.reports()[0]).toEqual([
        'state',
        run.runId,
        {
          state: 'failed',
          failure: {
            code: 'provider_disabled',
            detail: expect.stringMatching(/^Phase polish \(2\/2\) did not start: /),
          },
        },
      ]);
      expect(started).not.toHaveBeenCalled();
      expect(copies.located).toEqual([]);
    });

    it('gives the Phase its own Run step allowance', async () => {
      const run = next(
        provider,
        { position: 1, itemId: 'polish', count: 2, final: true },
        { completedSteps: 4, stepsBeforePart: 1, limits: { stepMinutes: 60, maxSteps: 3 } },
      );
      const api = new RecordingApi([run]);
      startWorker(api);

      await until(() => api.reports().length === 1);

      expect(api.reports()[0]?.[2]).toMatchObject({
        state: 'failed',
        failure: { code: 'step_limit' },
      });
    });
  });

  it('ends the Run at a Phase that fails, with the end of the Phase in the log and no delivery', async () => {
    const run = phaseRun('codex', {
      phase: { position: 0, itemId: 'build', count: 2, final: false },
    });
    const api = new RecordingApi([run]);
    const deliveries = new FakeDeliveries();
    const runner: Runner = {
      start: () => {
        throw new AgentFailedError('The agent gave up.');
      },
      resume: () => {
        throw new AgentFailedError('The agent gave up.');
      },
    };
    startWorker(api, runner, undefined, deliveries);

    await until(() => api.reports().length === 2);

    expect(api.reports()[1]?.[2]).toMatchObject({
      state: 'failed',
      failure: { code: 'agent_failed' },
    });
    expect(deliveries.calls).toEqual([]);
    expect(messages(api)).toContain('Phase build (1/2) ended: failed');
  });

  it('claims a Run started with an agent exactly as before: no Phase notice', async () => {
    const run = payload('Add a feature');
    const api = new RecordingApi([run]);
    startWorker(api);

    await until(() => api.reports().length === 3);

    expect(messages(api).filter((text) => text.startsWith('Phase '))).toEqual([]);
  });
});
