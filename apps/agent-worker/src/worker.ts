import {
  FAILURE_DETAIL_MAX_LENGTH,
  type RunFailure,
  type RunPayload,
  type RunStepResult,
  runStepResultSchema,
  type WorkingCopyReport,
  type WorkerStatusReport,
} from '@agentic-studio/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import { DeliveryFailedError, type DeliveryPort } from './delivery.js';
import { ProviderDisabledError } from './provider-gate.js';
import { RunLog } from './run-log.js';
import { AgentFailedError, drainRunStep, type Runner } from './runner.js';
import { isRunLost, type StudioApi } from './studio-api.js';
import { PreparationFailedError, type PreparedRun, type WorkingCopyPort } from './working-copy.js';

/** Where the worker writes what it does; never a token. */
export interface WorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

/** The worker routes the loop uses ({@link StudioApi} in production). */
export type WorkerApi = Pick<
  StudioApi,
  'claim' | 'reportState' | 'reportStep' | 'heartbeat' | 'reportStatus' | 'appendEvents'
>;

export interface AgentWorkerOptions {
  api: WorkerApi;
  runner: Runner;
  /** Prepares and inspects each Run's Working copy (Issue #98). */
  workingCopies: WorkingCopyPort;
  /** Commits, pushes and opens the draft pull request of a `done` Run (Issue #102). */
  deliveries: DeliveryPort;
  /**
   * Reported to Studio before every claim and with every heartbeat (Issue #101), so Studio
   * knows which providers this worker enables. Fixed for the life of the process.
   */
  status: WorkerStatusReport;
  /** Pause between two claims when there is no work, or after the API was unreachable. */
  pollMs: number;
  /** Interval of heartbeats while carrying a Run. */
  heartbeatMs: number;
  logger: WorkerLogger;
}

/** Longest wait for the Working copy's state that goes with a failure report. */
const FAILURE_REPORT_TIMEOUT_MS = 30_000;

/** The failure reported for the Run being carried when the worker shuts down (Issue #96). */
export const SHUTDOWN_FAILURE: RunFailure = { code: 'worker_lost', detail: 'worker shut down' };

const UNEXPECTED_FAILURE: RunFailure = {
  code: 'unknown',
  detail: 'The runner stopped unexpectedly. The agent worker log has the details.',
};

/** How long a stopping worker still tries to deliver the Run's buffered log. */
const SHUTDOWN_LOG_DEADLINE_MS = 2000;

/** The number of the Run step the worker carries out (resume steps come with #103). */
const START_STEP = 1;

const INVALID_RESULT_FAILURE: RunFailure = {
  code: 'agent_failed',
  detail: "The agent's structured result was not valid.",
};

/** A delivery retry that stopped for a reason other than a {@link DeliveryFailedError}. */
const DELIVERY_SHUTDOWN_FAILURE: RunFailure = {
  code: 'delivery_failed',
  detail: 'The agent worker shut down during the delivery. Retry the delivery.',
};
const DELIVERY_UNEXPECTED_FAILURE: RunFailure = {
  code: 'delivery_failed',
  detail: 'The delivery stopped unexpectedly. The agent worker log has the details.',
};

/**
 * The agent worker's loop (Issue #96): claim a Run, prepare its Working copy while the Run is
 * `preparing` (Issue #98), carry it out through the runner while sending heartbeats, commit
 * what a `done` step left, report its Run step result with the Working copy's state, deliver
 * it (Issue #102: push the Run branch, open the draft pull request) and report its final state,
 * repeat. The Run's events are forwarded to Studio as they happen (Issue #99). A claim of kind
 * `deliver` (a delivery retry) only delivers from the kept Working copy. It carries
 * one Run at a time. {@link stop} ends the loop: polling stops, the runner is aborted, and a Run
 * still being carried is reported `failed` with `worker_lost` ("worker shut down").
 */
export class AgentWorker {
  private stopping = false;
  /** Aborted by {@link stop}: wakes the idle pause and abandons in-flight calls. */
  private readonly shutdown = new AbortController();
  private current: AbortController | undefined;
  private currentRunId: string | undefined;
  /** Whether the Run being carried is in its delivery: then every failure is delivery_failed. */
  private delivering = false;
  private loop: Promise<void> | undefined;

  constructor(private readonly options: AgentWorkerOptions) {}

  /** The Run this worker carries right now, if any (retention never removes its directory). */
  get carrying(): string | undefined {
    return this.currentRunId;
  }

  /** Starts the loop; resolves when it has stopped. */
  run(): Promise<void> {
    this.loop ??= this.poll();
    return this.loop;
  }

  /** Stops the loop and waits until the Run being carried (if any) has been reported. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.shutdown.abort();
    this.current?.abort(new Error('worker shut down'));
    await this.loop;
  }

  private async poll(): Promise<void> {
    const { api, logger, pollMs } = this.options;
    while (!this.stopping) {
      let run: RunPayload | null = null;
      await this.reportStatus();
      try {
        run = await api.claim(this.shutdown.signal);
      } catch (error) {
        logger.error(`Claiming a run failed: ${describe(error)}`);
      }
      if (run) {
        await this.carry(run);
      } else {
        await this.pause(pollMs);
      }
    }
  }

  private async carry(run: RunPayload): Promise<void> {
    const { api, logger, heartbeatMs } = this.options;
    const abort = new AbortController();
    this.current = abort;
    this.currentRunId = run.runId;
    let lost = false;
    let prepared: PreparedRun | undefined;
    const markLost = () => {
      lost = true;
      abort.abort(new Error('run lost'));
    };
    logger.info(`Carrying run ${run.runId} (${run.provider}).`);
    // The Run's events go to Studio as they happen (Issue #99).
    const log = new RunLog({ api, runId: run.runId, logger, onLost: markLost });
    const heartbeats = setInterval(() => {
      // Keeps Studio's view of this worker fresh while it carries a long Run.
      void this.reportStatus();
      api.heartbeat(run.runId, this.shutdown.signal).catch((error: unknown) => {
        if (isRunLost(error) || error instanceof RunLostError) markLost();
        logger.error(`Heartbeat for run ${run.runId} failed: ${describe(error)}`);
      });
    }, heartbeatMs);
    heartbeats.unref();
    try {
      // A stop that arrived while the claim was in flight.
      if (this.stopping) abort.abort(new Error('worker shut down'));
      abort.signal.throwIfAborted();
      if (run.kind === 'deliver') {
        prepared = await this.retryDelivery(run, abort.signal, (located) => (prepared = located));
        return;
      }
      const signal = this.shutdown.signal;
      prepared = await this.options.workingCopies.prepare(run, abort.signal);
      abort.signal.throwIfAborted();
      await api.reportState(run.runId, { state: 'running' }, signal);
      const result = await this.executeStart(run, prepared, abort.signal, log);
      abort.signal.throwIfAborted();
      // The log goes first: Studio accepts events only while the worker holds the Run.
      await log.close();
      abort.signal.throwIfAborted();
      // What a done step left is committed before its report, so the report lists that commit;
      // a refused commit still lets the step's result be reported first.
      let commitFailure: DeliveryFailedError | undefined;
      if (result.outcome === 'done') {
        await this.options.deliveries
          .commit(prepared, run, result, abort.signal)
          .catch((error: unknown) => {
            if (!(error instanceof DeliveryFailedError)) throw error;
            commitFailure = error;
          });
      }
      const workingCopy = await this.options.workingCopies.report(prepared, abort.signal);
      await api.reportStep(run.runId, { kind: 'start', result, workingCopy }, signal);
      if (result.outcome === 'needs_input') {
        await api.reportState(run.runId, { state: 'waiting_for_operator' }, signal);
      } else {
        if (commitFailure) throw commitFailure;
        // From here a stop or a crash leaves a delivery to retry, not a lost Run (review of #122).
        this.delivering = true;
        const delivery = await this.options.deliveries.deliver(prepared, run, result, abort.signal);
        await api.reportState(run.runId, { state: 'succeeded', delivery }, signal);
      }
      logger.info(`Run ${run.runId} reported: ${result.outcome}.`);
    } catch (error) {
      if (!lost) await log.close(this.stopping ? SHUTDOWN_LOG_DEADLINE_MS : undefined);
      await this.reportFailure(run, lost ? new RunLostError() : error, prepared);
    } finally {
      log.dispose();
      clearInterval(heartbeats);
      this.delivering = false;
      this.current = undefined;
      this.currentRunId = undefined;
    }
  }

  /**
   * A delivery retry (Issue #102): finds the Run's Working copy and the agent's kept result,
   * commits anything left and delivers; reports `succeeded` with the delivery and the Working
   * copy's state. Failures are reported by the caller, always as `delivery_failed`.
   */
  private async retryDelivery(
    run: RunPayload,
    signal: AbortSignal,
    located: (prepared: PreparedRun) => void,
  ): Promise<PreparedRun> {
    const { deliveries, workingCopies, api, logger } = this.options;
    const { prepared, result } = await deliveries.locate(run);
    located(prepared);
    await deliveries.commit(prepared, run, result, signal);
    const delivery = await deliveries.deliver(prepared, run, result, signal);
    signal.throwIfAborted();
    const workingCopy = await workingCopies.report(prepared, signal);
    await api.reportState(
      run.runId,
      { state: 'succeeded', delivery, workingCopy },
      this.shutdown.signal,
    );
    logger.info(`Run ${run.runId} delivered on retry: ${delivery.outcome}.`);
    return prepared;
  }

  /** The first Run step, its events forwarded between a start and an end marker. */
  private async executeStart(
    run: RunPayload,
    prepared: PreparedRun,
    signal: AbortSignal,
    log: RunLog,
  ): Promise<RunStepResult> {
    const workspace = { repoDir: prepared.repoDir, runDir: prepared.runDir, env: prepared.env };
    log.push(START_STEP, 'step_started', `Run step ${START_STEP} started`);
    let result: RunStepResult;
    try {
      result = await drainRunStep(this.options.runner.start({ run, workspace, signal }), (event) =>
        log.push(START_STEP, event.type, event.text),
      );
    } catch (error) {
      log.push(START_STEP, 'step_finished', `Run step ${START_STEP} ended without a result`);
      throw error;
    }
    const parsed = runStepResultSchema.safeParse(result);
    if (!parsed.success) {
      log.push(START_STEP, 'step_finished', `Run step ${START_STEP} ended with an invalid result`);
      throw new InvalidResultError();
    }
    log.push(
      START_STEP,
      'step_finished',
      `Run step ${START_STEP} finished: ${parsed.data.outcome}`,
    );
    return parsed.data;
  }

  private async reportFailure(
    run: RunPayload,
    error: unknown,
    prepared: PreparedRun | undefined,
  ): Promise<void> {
    const { api, logger } = this.options;
    if (isRunLost(error) || error instanceof RunLostError) {
      logger.error(`Run ${run.runId} is no longer held by this worker; dropping it.`);
      return;
    }
    const failure =
      run.kind === 'deliver' || this.delivering
        ? this.deliveryFailure(error)
        : this.runFailure(error);
    if (failure === UNEXPECTED_FAILURE || failure === DELIVERY_UNEXPECTED_FAILURE) {
      logger.error(`Run ${run.runId} stopped unexpectedly: ${describe(error)}`);
    }
    try {
      // Not tied to the shutdown signal: on stop this is the report that must still go out
      // (bounded by the request timeout).
      // What the failed or crashed step left in the Working copy (coordinator decision on #98),
      // when it can be read; the failure is reported either way.
      const workingCopy = prepared ? await this.readWorkingCopy(run, prepared) : undefined;
      await api.reportState(run.runId, {
        state: 'failed',
        failure,
        ...(workingCopy ? { workingCopy } : {}),
      });
      logger.info(`Run ${run.runId} reported: failed (${failure.code}).`);
    } catch (reportError) {
      logger.error(`Reporting run ${run.runId} as failed failed: ${describe(reportError)}`);
    }
  }

  /** The failure of a Run being started. */
  private runFailure(error: unknown): RunFailure {
    if (this.stopping) return SHUTDOWN_FAILURE;
    if (error instanceof PreparationFailedError) return failure('preparation_failed', error.detail);
    if (error instanceof ProviderDisabledError) return failure('provider_disabled', error.message);
    if (error instanceof AgentFailedError) return failure('agent_failed', error.message);
    if (error instanceof InvalidResultError) return INVALID_RESULT_FAILURE;
    if (error instanceof DeliveryFailedError) return failure('delivery_failed', error.detail);
    return UNEXPECTED_FAILURE;
  }

  /** A delivery retry fails only as `delivery_failed`, so it can be retried again. */
  private deliveryFailure(error: unknown): RunFailure {
    if (error instanceof DeliveryFailedError) return failure('delivery_failed', error.detail);
    return this.stopping ? DELIVERY_SHUTDOWN_FAILURE : DELIVERY_UNEXPECTED_FAILURE;
  }

  /** The Working copy's state for a failure report, or `undefined` if it cannot be read in time. */
  private async readWorkingCopy(
    run: RunPayload,
    prepared: PreparedRun,
  ): Promise<WorkingCopyReport | undefined> {
    try {
      return await this.options.workingCopies.report(
        prepared,
        AbortSignal.timeout(FAILURE_REPORT_TIMEOUT_MS),
      );
    } catch (error) {
      this.options.logger.error(
        `Reading the Working copy of run ${run.runId} failed: ${describe(error)}`,
      );
      return undefined;
    }
  }

  /** Never throws: a failed status report is logged, and the loop goes on. */
  private async reportStatus(): Promise<void> {
    try {
      await this.options.api.reportStatus(this.options.status, this.shutdown.signal);
    } catch (error) {
      if (!this.stopping)
        this.options.logger.error(`Reporting the status failed: ${describe(error)}`);
    }
  }

  private async pause(ms: number): Promise<void> {
    try {
      await delay(ms, undefined, { signal: this.shutdown.signal });
    } catch {
      // Woken by stop().
    }
  }
}

/** A heartbeat learned that this worker no longer holds the Run. */
class RunLostError extends Error {
  constructor() {
    super('run lost');
    this.name = 'RunLostError';
  }
}

class InvalidResultError extends Error {
  constructor() {
    super('invalid structured result');
    this.name = 'InvalidResultError';
  }
}

/** A failure with its detail cut to the protocol's limit. */
function failure(code: RunFailure['code'], detail: string): RunFailure {
  return { code, detail: detail.slice(0, FAILURE_DETAIL_MAX_LENGTH) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
