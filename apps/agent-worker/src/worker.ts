import {
  type RunFailure,
  type RunPayload,
  type RunStepResult,
  runStepResultSchema,
} from '@agentic-studio/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentFailedError, drainRunStep, type Runner } from './runner.js';
import { isRunLost, type StudioApi } from './studio-api.js';

/** Where the worker writes what it does; never a token. */
export interface WorkerLogger {
  info(message: string): void;
  error(message: string): void;
}

/** The worker routes the loop uses ({@link StudioApi} in production). */
export type WorkerApi = Pick<StudioApi, 'claim' | 'reportState' | 'reportStep' | 'heartbeat'>;

export interface AgentWorkerOptions {
  api: WorkerApi;
  runner: Runner;
  /** Pause between two claims when there is no work, or after the API was unreachable. */
  pollMs: number;
  /** Interval of heartbeats while carrying a Run. */
  heartbeatMs: number;
  logger: WorkerLogger;
}

/** The failure reported for the Run being carried when the worker shuts down (Issue #96). */
export const SHUTDOWN_FAILURE: RunFailure = { code: 'worker_lost', detail: 'worker shut down' };

const UNEXPECTED_FAILURE: RunFailure = {
  code: 'unknown',
  detail: 'The runner stopped unexpectedly. The agent worker log has the details.',
};

const INVALID_RESULT_FAILURE: RunFailure = {
  code: 'agent_failed',
  detail: "The agent's structured result was not valid.",
};

/**
 * The agent worker's loop (Issue #96): claim a Run, carry it out through the runner while
 * sending heartbeats, report its Run step result and final state, repeat. It carries one Run
 * at a time. {@link stop} ends the loop: polling stops, the runner is aborted, and a Run
 * still being carried is reported `failed` with `worker_lost` ("worker shut down").
 */
export class AgentWorker {
  private stopping = false;
  /** Aborted by {@link stop}: wakes the idle pause and abandons in-flight calls. */
  private readonly shutdown = new AbortController();
  private current: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(private readonly options: AgentWorkerOptions) {}

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
    let lost = false;
    logger.info(`Carrying run ${run.runId} (${run.provider}).`);
    const heartbeats = setInterval(() => {
      api.heartbeat(run.runId, this.shutdown.signal).catch((error: unknown) => {
        if (isRunLost(error) || error instanceof RunLostError) {
          lost = true;
          abort.abort(new Error('run lost'));
        }
        logger.error(`Heartbeat for run ${run.runId} failed: ${describe(error)}`);
      });
    }, heartbeatMs);
    heartbeats.unref();
    try {
      // A stop that arrived while the claim was in flight.
      if (this.stopping) abort.abort(new Error('worker shut down'));
      abort.signal.throwIfAborted();
      const signal = this.shutdown.signal;
      await api.reportState(run.runId, { state: 'running' }, signal);
      const result = await this.executeStart(run, abort.signal);
      abort.signal.throwIfAborted();
      await api.reportStep(run.runId, { kind: 'start', result }, signal);
      await api.reportState(
        run.runId,
        { state: result.outcome === 'needs_input' ? 'waiting_for_operator' : 'succeeded' },
        signal,
      );
      logger.info(`Run ${run.runId} reported: ${result.outcome}.`);
    } catch (error) {
      await this.reportFailure(run, lost ? new RunLostError() : error);
    } finally {
      clearInterval(heartbeats);
      this.current = undefined;
    }
  }

  private async executeStart(run: RunPayload, signal: AbortSignal): Promise<RunStepResult> {
    const result = await drainRunStep(this.options.runner.start({ run, signal }), (event) =>
      this.options.logger.info(`Run ${run.runId} ${event.type}: ${event.text}`),
    );
    const parsed = runStepResultSchema.safeParse(result);
    if (!parsed.success) throw new InvalidResultError();
    return parsed.data;
  }

  private async reportFailure(run: RunPayload, error: unknown): Promise<void> {
    const { api, logger } = this.options;
    if (isRunLost(error) || error instanceof RunLostError) {
      logger.error(`Run ${run.runId} is no longer held by this worker; dropping it.`);
      return;
    }
    const failure = this.stopping
      ? SHUTDOWN_FAILURE
      : error instanceof AgentFailedError
        ? { code: 'agent_failed' as const, detail: error.message.slice(0, 2000) }
        : error instanceof InvalidResultError
          ? INVALID_RESULT_FAILURE
          : UNEXPECTED_FAILURE;
    if (failure === UNEXPECTED_FAILURE) {
      logger.error(`Run ${run.runId} stopped unexpectedly: ${describe(error)}`);
    }
    try {
      // Not tied to the shutdown signal: on stop this is the report that must still go out
      // (bounded by the request timeout).
      await api.reportState(run.runId, { state: 'failed', failure });
      logger.info(`Run ${run.runId} reported: failed (${failure.code}).`);
    } catch (reportError) {
      logger.error(`Reporting run ${run.runId} as failed failed: ${describe(reportError)}`);
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
