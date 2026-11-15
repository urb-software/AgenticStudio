import {
  FAILURE_DETAIL_MAX_LENGTH,
  type Provider,
  type RunFailure,
  type RunPayload,
  type RunStepResult,
  runStepResultSchema,
  type WorkingCopyReport,
  type WorkerStatusReport,
} from '@agentic-studio/contracts';
import { posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DeliveryFailedError, type DeliveryPort } from './delivery.js';
import { ProviderDisabledError } from './provider-gate.js';
import { type Backoff, ReportOutbox } from './report-outbox.js';
import { RunLog } from './run-log.js';
import { composeProjectName, STEP_PROCESSES_FILE } from './run-layout.js';
import type { RunResources } from './run-resources.js';
import { AgentFailedError, drainRunStep, type Runner } from './runner.js';
import { StepProcesses } from './step-processes.js';
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

/** The process groups of one Run step ({@link StepProcesses} in production). */
export type StepProcessGroups = Pick<StepProcesses, 'register' | 'terminate' | 'release'>;

export interface AgentWorkerOptions {
  api: WorkerApi;
  runner: Runner;
  /**
   * The provider gate (Issue #101), checked before a Run's Working copy is prepared (note on
   * #117), so a Run for a switched-off provider fetches nothing. The runner dispatcher checks it
   * again before every Run step, and the spawn boundary before any CLI process.
   */
  gate: { assertEnabled(provider: Provider): void };
  /** Prepares and inspects each Run's Working copy (Issue #98). */
  workingCopies: WorkingCopyPort;
  /** Commits, pushes and opens the draft pull request of a `done` Run (Issue #102). */
  deliveries: DeliveryPort;
  /** Removes a stopped Run's containers through its Compose project (Issue #100). */
  resources: RunResources;
  /**
   * Reported to Studio before every claim and with every heartbeat (Issue #101), so Studio
   * knows which providers this worker enables. Fixed for the life of the process.
   */
  status: WorkerStatusReport;
  /** Pause between two claims when there is no work, or after the API was unreachable. */
  pollMs: number;
  /** Interval of heartbeats while carrying a Run. */
  heartbeatMs: number;
  /** Grace between the interrupt and the kill of a stopped Run step's processes (Issue #100). */
  killGraceMs: number;
  logger: WorkerLogger;
  /** Test seam: the length of one minute of a Run step's time limit (default 60 000 ms). */
  minuteMs?: number;
  /** Test seam: the backoff of report deliveries while Studio is unreachable. */
  reportBackoff?: Backoff;
  /** Test seam: the process groups of a Run step (default: recorded in the Run's directory). */
  processesFor?: (prepared: PreparedRun) => StepProcessGroups;
}

/** Longest wait for the Working copy's state that goes with a failure report. */
const FAILURE_REPORT_TIMEOUT_MS = 30_000;

/** The failure reported for the Run being carried when the worker shuts down (Issue #96). */
export const SHUTDOWN_FAILURE: RunFailure = { code: 'worker_lost', detail: 'worker shut down' };

const UNEXPECTED_FAILURE: RunFailure = {
  code: 'unknown',
  detail: 'The runner stopped unexpectedly. The agent worker log has the details.',
};

/** How long a stopping worker still tries to deliver the Run's buffered log (Issue #99). */
const SHUTDOWN_LOG_DEADLINE_MS = 2000;

/**
 * How long the worker keeps trying to deliver a Run's log before its end report while Studio is
 * unreachable (Issue #100): the step's events are part of the buffered reports, so a Studio
 * outage drops none of them (only the worker's own buffer bound does, as in #99).
 */
const LOG_OUTAGE_DEADLINE_MS = 24 * 60 * 60 * 1000;

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

/** Why a Run step was stopped before its end (Issue #100). */
export type StopReason = 'cancel' | 'timeout' | 'lost' | 'shutdown';

/** The abort reason of a stopped Run step. */
export class StepStoppedError extends Error {
  constructor(readonly reason: StopReason) {
    super(`run step stopped: ${reason}`);
    this.name = 'StepStoppedError';
  }
}

/** The next Run step would exceed the Run's maximum (Issue #100). */
export class StepLimitError extends Error {
  constructor(readonly maxSteps: number) {
    super(
      `The run reached its limit of ${maxSteps} run ${maxSteps === 1 ? 'step' : 'steps'}; ` +
        'no further step was started.',
    );
    this.name = 'StepLimitError';
  }
}

/**
 * The agent worker's loop (Issue #96): claim a Run, prepare its Working copy while the Run is
 * `preparing` (Issue #98), carry it out through the runner while sending heartbeats, commit
 * what a `done` step left, report its Run step result with the Working copy's state, deliver
 * it (Issue #102: push the Run branch, open the draft pull request) and report its final state,
 * repeat. The Run's events are forwarded to Studio as they happen (Issue #99). A claim of kind
 * `deliver` (a delivery retry) only delivers from the kept Working copy. It carries one Run at
 * a time.
 *
 * Issue #100: a Run step is stopped when the heartbeat answer carries the operator's cancel,
 * when it reaches its time limit, when Studio says the worker lost the Run, or when the worker
 * stops: the runner is aborted, the step's process groups get SIGINT, then SIGKILL after the
 * grace, and the Run's containers are removed (its Working copy is kept). The Run is then
 * reported `cancelled`, `timed_out`, nothing (lost), or `failed` with `worker_lost` ("worker
 * shut down"). A step that would exceed the Run's maximum is not started (`step_limit`). While
 * Studio is unreachable the step keeps going and its reports wait, in order, in an outbox. A
 * delivery starts only while no stop is pending; a stop or a crash during it leaves a delivery
 * to retry (`delivery_failed`), except an operator's cancel, which ends the Run `cancelled`.
 */
export class AgentWorker {
  private stopping = false;
  /** Aborted by {@link stop}: wakes the idle pause and abandons in-flight calls. */
  private readonly shutdown = new AbortController();
  private stopCurrent: ((reason: StopReason) => void) | undefined;
  private currentRunId: string | undefined;
  /** Whether the Run being carried is in its delivery: then a failure is delivery_failed. */
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

  /** Stops the loop and waits until the Run being carried (if any) is stopped and reported. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.shutdown.abort();
    this.stopCurrent?.('shutdown');
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
    const stop = (reason: StopReason) => {
      if (!abort.signal.aborted) abort.abort(new StepStoppedError(reason));
    };
    this.stopCurrent = stop;
    this.currentRunId = run.runId;
    const outbox = new ReportOutbox({
      signal: this.shutdown.signal,
      backoff: this.options.reportBackoff,
      onLost: () => stop('lost'),
      logger,
    });
    let prepared: PreparedRun | undefined;
    let processes: StepProcessGroups | undefined;
    logger.info(`Carrying run ${run.runId} (${run.provider}).`);
    // The Run's events go to Studio as they happen (Issue #99).
    const log = new RunLog({ api, runId: run.runId, logger, onLost: () => stop('lost') });
    const heartbeats = setInterval(() => {
      // Keeps Studio's view of this worker fresh while it carries a long Run.
      void this.reportStatus();
      api.heartbeat(run.runId, this.shutdown.signal).then(
        (answer) => {
          if (answer.cancelRequested && !abort.signal.aborted) {
            logger.info(`Run ${run.runId}: the operator cancelled it.`);
            stop('cancel');
          }
        },
        (error: unknown) => {
          // A Studio outage is not a reason to stop: the step goes on (Issue #100).
          if (isRunLost(error)) stop('lost');
          logger.error(`Heartbeat for run ${run.runId} failed: ${describe(error)}`);
        },
      );
    }, heartbeatMs);
    heartbeats.unref();
    try {
      // A stop that arrived while the claim was in flight.
      if (this.stopping) stop('shutdown');
      abort.signal.throwIfAborted();
      if (run.kind === 'deliver') {
        await this.retryDelivery(run, abort.signal, outbox, (located) => (prepared = located));
        return;
      }
      // Before anything is fetched (note on #117); the dispatcher checks again before the step.
      this.options.gate.assertEnabled(run.provider);
      if (run.completedSteps + 1 > run.limits.maxSteps) {
        throw new StepLimitError(run.limits.maxSteps);
      }
      prepared = await this.options.workingCopies.prepare(run, abort.signal);
      abort.signal.throwIfAborted();
      outbox.send('running', (signal) => api.reportState(run.runId, { state: 'running' }, signal));
      processes = this.processesFor(prepared);
      const limit = setTimeout(
        () => {
          if (abort.signal.aborted) return;
          logger.info(`Run ${run.runId}: the run step reached its time limit.`);
          stop('timeout');
        },
        run.limits.stepMinutes * (this.options.minuteMs ?? 60_000),
      );
      let result: RunStepResult;
      try {
        result = await this.executeStart(run, prepared, processes, abort.signal, log);
      } finally {
        clearTimeout(limit);
      }
      abort.signal.throwIfAborted();
      // The log goes first: Studio accepts events only while the worker holds the Run.
      await this.closeLog(log);
      abort.signal.throwIfAborted();
      // What a done step left is committed before its report, so the report lists that commit;
      // a refused commit still lets the step's result be reported first (Issue #102).
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
      outbox.send('step', (signal) =>
        api.reportStep(
          run.runId,
          // Numbered, so a retry of a report Studio already stored is not stored twice.
          { index: run.completedSteps + 1, kind: 'start', result, workingCopy },
          signal,
        ),
      );
      if (result.outcome === 'needs_input') {
        outbox.send('waiting_for_operator', (signal) =>
          api.reportState(run.runId, { state: 'waiting_for_operator' }, signal),
        );
      } else {
        if (commitFailure) throw commitFailure;
        // Nothing is pushed once a stop is pending (Issue #100).
        abort.signal.throwIfAborted();
        // From here a stop or a crash leaves a delivery to retry, not a lost Run (review of #122).
        this.delivering = true;
        const delivery = await this.options.deliveries.deliver(prepared, run, result, abort.signal);
        outbox.send('succeeded', (signal) =>
          api.reportState(run.runId, { state: 'succeeded', delivery }, signal),
        );
      }
      await outbox.drain();
      if (outbox.lost) logger.error(`Run ${run.runId} is no longer held by this worker.`);
      else logger.info(`Run ${run.runId} reported: ${result.outcome}.`);
    } catch (error) {
      const reason =
        abort.signal.aborted && abort.signal.reason instanceof StepStoppedError
          ? abort.signal.reason.reason
          : undefined;
      if (reason === 'cancel') log.push(START_STEP, 'notice', 'Run step stopped: cancelled');
      if (reason === 'timeout') {
        log.push(
          START_STEP,
          'notice',
          `Run step stopped: its time limit of ${run.limits.stepMinutes} minutes was reached`,
        );
      }
      if (reason !== 'lost') await this.closeLog(log);
      await this.finish(run, error, reason, {
        prepared,
        stepStarted: processes !== undefined,
        outbox,
      });
    } finally {
      log.dispose();
      clearInterval(heartbeats);
      this.delivering = false;
      await processes?.release().catch((error: unknown) => {
        logger.error(`Forgetting the processes of run ${run.runId} failed: ${describe(error)}`);
      });
      this.stopCurrent = undefined;
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
    outbox: ReportOutbox,
    located: (prepared: PreparedRun) => void,
  ): Promise<void> {
    const { deliveries, workingCopies, api, logger } = this.options;
    const { prepared, result } = await deliveries.locate(run);
    located(prepared);
    await deliveries.commit(prepared, run, result, signal);
    const delivery = await deliveries.deliver(prepared, run, result, signal);
    signal.throwIfAborted();
    const workingCopy = await workingCopies.report(prepared, signal);
    outbox.send('succeeded', (reportSignal) =>
      api.reportState(run.runId, { state: 'succeeded', delivery, workingCopy }, reportSignal),
    );
    await outbox.drain();
    if (outbox.lost) logger.error(`Run ${run.runId} is no longer held by this worker.`);
    else logger.info(`Run ${run.runId} delivered on retry: ${delivery.outcome}.`);
  }

  /**
   * Delivers the Run's buffered log before its end report: through a Studio outage (Issue #100),
   * but only {@link SHUTDOWN_LOG_DEADLINE_MS} more once the worker stops.
   */
  private async closeLog(log: RunLog): Promise<void> {
    const shutdown = this.shutdown.signal;
    if (shutdown.aborted) return log.close(SHUTDOWN_LOG_DEADLINE_MS);
    let onStop: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      onStop = () => resolve();
      shutdown.addEventListener('abort', onStop, { once: true });
    });
    await Promise.race([log.close(LOG_OUTAGE_DEADLINE_MS), stopped]);
    shutdown.removeEventListener('abort', onStop!);
    // A later close sets the shorter deadline on the same delivery.
    if (shutdown.aborted) await log.close(SHUTDOWN_LOG_DEADLINE_MS);
  }

  private processesFor(prepared: PreparedRun): StepProcessGroups {
    return (
      this.options.processesFor?.(prepared) ??
      new StepProcesses(posix.join(prepared.runDir, STEP_PROCESSES_FILE))
    );
  }

  /**
   * Runs the first Run step, its events forwarded between a start and an end marker
   * (Issue #99). However it ends, the step's process groups are terminated
   * afterwards (SIGINT, the grace, SIGKILL): when the step is stopped this is what stops it,
   * and otherwise nothing it started outlives it. A stopped step that does not end within the
   * grace (a runner that ignores the abort) is abandoned.
   */
  private async executeStart(
    run: RunPayload,
    prepared: PreparedRun,
    processes: StepProcessGroups,
    signal: AbortSignal,
    log: RunLog,
  ): Promise<RunStepResult> {
    const workspace = { repoDir: prepared.repoDir, runDir: prepared.runDir, env: prepared.env };
    // The Environment file is in the Working copy (Issue #104); its content goes to the runner
    // no other way (never in a prompt, an argument or the process environment).
    const { environmentFile, ...forRunner } = run;
    void environmentFile;
    log.push(START_STEP, 'step_started', `Run step ${START_STEP} started`);
    const step = drainRunStep(
      this.options.runner.start({ run: forRunner, workspace, signal, processes }),
      (event) => log.push(START_STEP, event.type, event.text),
    );
    const stopped = rejectOnAbort(signal);
    // An abandoned step's late end, or a stop after the step ended, must not surface as an
    // unhandled rejection.
    step.catch(() => undefined);
    stopped.catch(() => undefined);
    let result: RunStepResult;
    try {
      result = await Promise.race([step, stopped]);
    } catch (error) {
      log.push(START_STEP, 'step_finished', `Run step ${START_STEP} ended without a result`);
      throw error;
    } finally {
      const killed = await processes.terminate(this.options.killGraceMs, step);
      if (killed.length > 0) {
        this.options.logger.info(
          `Run ${run.runId}: killed ${killed.length} process group(s) after the grace period.`,
        );
      }
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

  /** Reports how a Run ended when its step did not end normally. */
  private async finish(
    run: RunPayload,
    error: unknown,
    reason: StopReason | undefined,
    context: { prepared: PreparedRun | undefined; stepStarted: boolean; outbox: ReportOutbox },
  ): Promise<void> {
    const { api, logger } = this.options;
    const { prepared, outbox } = context;
    // The Run's containers go with any stop once its step has started (Issue #100).
    if (reason !== undefined && context.stepStarted) await this.removeContainers(run);
    if (reason === 'lost' || outbox.lost || isRunLost(error)) {
      logger.error(`Run ${run.runId} is no longer held by this worker; dropping it.`);
      return;
    }
    // What the stopped, failed or crashed step left in the Working copy (coordinator decision
    // on #98), when it can be read; the end is reported either way.
    const workingCopy = prepared ? await this.readWorkingCopy(run, prepared) : undefined;
    const withWorkingCopy = workingCopy ? { workingCopy } : {};
    // A delivery (retry or first) that did not finish leaves a delivery to retry (Issue #102);
    // only an operator's cancel ends a first delivery as cancelled.
    const inDelivery = run.kind === 'deliver' || (this.delivering && reason !== 'cancel');
    if (inDelivery) {
      const deliveryFailure = this.deliveryFailure(error);
      if (deliveryFailure === DELIVERY_UNEXPECTED_FAILURE) {
        logger.error(`Run ${run.runId} stopped unexpectedly: ${describe(error)}`);
      }
      const send = (signal?: AbortSignal) =>
        api.reportState(
          run.runId,
          { state: 'failed', failure: deliveryFailure, ...withWorkingCopy },
          signal,
        );
      try {
        if (this.stopping) await send();
        else {
          outbox.send('failed', send);
          await outbox.drain();
        }
        logger.info(`Run ${run.runId} reported: failed (delivery_failed).`);
      } catch (reportError) {
        logger.error(`Reporting run ${run.runId} as failed failed: ${describe(reportError)}`);
      }
      return;
    }
    if (this.stopping || reason === 'shutdown') {
      try {
        // Not tied to the shutdown signal and not queued: on stop this is the report that must
        // still go out (bounded by the request timeout).
        await api.reportState(run.runId, {
          state: 'failed',
          failure: SHUTDOWN_FAILURE,
          ...withWorkingCopy,
        });
        logger.info(`Run ${run.runId} reported: failed (${SHUTDOWN_FAILURE.code}).`);
      } catch (reportError) {
        logger.error(`Reporting run ${run.runId} as failed failed: ${describe(reportError)}`);
      }
      return;
    }
    if (reason === 'cancel' || reason === 'timeout') {
      const state = reason === 'cancel' ? 'cancelled' : 'timed_out';
      outbox.send(state, (signal) =>
        api.reportState(run.runId, { state, ...withWorkingCopy }, signal),
      );
      await outbox.drain();
      logger.info(`Run ${run.runId} reported: ${state}.`);
      return;
    }
    const failure = failureOf(error);
    if (failure === UNEXPECTED_FAILURE) {
      logger.error(`Run ${run.runId} stopped unexpectedly: ${describe(error)}`);
    }
    outbox.send('failed', (signal) =>
      api.reportState(run.runId, { state: 'failed', failure, ...withWorkingCopy }, signal),
    );
    await outbox.drain();
    logger.info(`Run ${run.runId} reported: failed (${failure.code}).`);
  }

  /** A delivery fails only as `delivery_failed`, so it can be retried again. */
  private deliveryFailure(error: unknown): RunFailure {
    if (error instanceof DeliveryFailedError) return failure('delivery_failed', error.detail);
    return this.stopping ? DELIVERY_SHUTDOWN_FAILURE : DELIVERY_UNEXPECTED_FAILURE;
  }

  /** Removes the Run's containers, networks and volumes; a failure is logged (retention retries). */
  private async removeContainers(run: RunPayload): Promise<void> {
    try {
      await this.options.resources.cleanUp(composeProjectName(run.runId));
    } catch (error) {
      this.options.logger.error(
        `Removing the containers of run ${run.runId} failed: ${describe(error)}`,
      );
    }
  }

  /** The Working copy's state for an end report, or `undefined` if it cannot be read in time. */
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

/** The failure a Run step's error is reported with. */
function failureOf(error: unknown): RunFailure {
  if (error instanceof PreparationFailedError) return failure('preparation_failed', error.detail);
  if (error instanceof ProviderDisabledError) return failure('provider_disabled', error.message);
  if (error instanceof StepLimitError) return failure('step_limit', error.message);
  if (error instanceof AgentFailedError) return failure('agent_failed', error.message);
  if (error instanceof InvalidResultError) return INVALID_RESULT_FAILURE;
  // A refused commit of a done step (Issue #102).
  if (error instanceof DeliveryFailedError) return failure('delivery_failed', error.detail);
  return UNEXPECTED_FAILURE;
}

/** A failure with its detail cut to the protocol's limit. */
function failure(code: RunFailure['code'], detail: string): RunFailure {
  return { code, detail: detail.slice(0, FAILURE_DETAIL_MAX_LENGTH) };
}

/** Rejects with the signal's reason once it aborts. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason as Error);
    else signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

class InvalidResultError extends Error {
  constructor() {
    super('invalid structured result');
    this.name = 'InvalidResultError';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
