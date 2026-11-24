import {
  type OperationPayload,
  PREVIEW_FAILURE_DETAIL_MAX_LENGTH,
  PREVIEW_FAILURE_REFUSALS_MAX,
  type ReportOperationStateRequest,
} from '@agentic-studio/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import { type AbortReason, OperationAborted, OperationFailure } from './failure.js';
import { LogSink } from './log-sink.js';
import type { ControllerLogger } from './logger.js';
import type { OperationContext, OperationOutcome } from './preview-operations.js';
import {
  InvalidClaimError,
  isOperationLost,
  isTransient,
  StudioApi,
  StudioApiError,
} from './studio-api.js';

export interface ControllerOperations {
  execute(op: OperationPayload, context: OperationContext): Promise<OperationOutcome>;
  resumeRunning(context: OperationContext): Promise<{ resumed: number; failed: number }>;
}

export interface ControllerDeps {
  api: Pick<StudioApi, 'claim' | 'reportState' | 'appendLog'>;
  operations: ControllerOperations;
  logger: ControllerLogger;
  pollMs: number;
  heartbeatMs: number;
  /** Tries of the final report, and the first wait between them (it doubles, up to 15 s). */
  report?: { attempts: number; delayMs: number };
  /** Longest wait before a log line is sent. */
  logFlushMs?: number;
}

type Report = Omit<ReportOperationStateRequest, 'controllerId'>;

/**
 * Claims one operation at a time, carries it out, keeps its lease with a heartbeat and reports
 * the end. A 404 or 409 from the API means the operation is no longer this controller's: it is
 * abandoned without a report. On shutdown the operation in hand is reported `controller_stopped`.
 */
export class EnvironmentController {
  private readonly shutdown = new AbortController();
  private current: { abort: (reason: AbortReason) => void } | null = null;
  private loop: Promise<void> | null = null;
  private resumePending = true;
  private resumeBlockedLogged = false;

  constructor(private readonly deps: ControllerDeps) {}

  /** Runs until `stop`; resolves once the operation in hand is reported. */
  run(): Promise<void> {
    this.loop ??= this.runLoop();
    return this.loop;
  }

  async stop(): Promise<void> {
    this.shutdown.abort();
    this.current?.abort('shutdown');
    await this.loop;
  }

  private async runLoop(): Promise<void> {
    while (!this.shutdown.signal.aborted) {
      await this.resumeIfPending();
      let operation: OperationPayload | null = null;
      try {
        operation = await this.deps.api.claim(this.shutdown.signal);
      } catch (error) {
        await this.claimFailed(error);
      }
      if (operation) await this.carryOut(operation);
      else await this.pause();
    }
  }

  private async pause(): Promise<void> {
    await delay(this.deps.pollMs, undefined, { signal: this.shutdown.signal }).catch(
      () => undefined,
    );
  }

  private async resumeIfPending(): Promise<void> {
    if (!this.resumePending || this.shutdown.signal.aborted) return;
    try {
      const { resumed, failed } = await this.deps.operations.resumeRunning({
        signal: this.shutdown.signal,
        log: () => undefined,
      });
      this.resumePending = false;
      this.deps.logger.event('previews_resumed', {
        outcome: `${resumed} started, ${failed} failed`,
      });
    } catch (error) {
      if (this.shutdown.signal.aborted) return;
      if (!this.resumeBlockedLogged) {
        this.resumeBlockedLogged = true;
        this.deps.logger.event('resume_blocked', {
          outcome: error instanceof OperationFailure ? error.code : 'controller_error',
        });
      }
    }
  }

  private async claimFailed(error: unknown): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    if (error instanceof InvalidClaimError) {
      this.deps.logger.event('claim_unreadable', {
        operationId: error.operationId ?? undefined,
        outcome: 'controller_error',
      });
      if (error.operationId) {
        await this.report(error.operationId, undefined, {
          state: 'failed',
          failure: { code: 'controller_error', detail: 'The operation could not be read.' },
        });
      }
      return;
    }
    this.deps.logger.event('claim_failed', {
      outcome: error instanceof StudioApiError ? `http_${error.status}` : 'unreachable',
    });
    await this.pause();
  }

  private async carryOut(op: OperationPayload): Promise<void> {
    const { api, logger } = this.deps;
    const fields = { operationId: op.operationId, projectId: op.projectId, kind: op.kind };
    logger.event('operation_claimed', fields);
    const abort = new AbortController();
    let reason: AbortReason | null = null;
    const stopWith = (why: AbortReason) => {
      if (reason !== null) return;
      reason = why;
      abort.abort();
    };
    this.current = { abort: stopWith };
    if (this.shutdown.signal.aborted) stopWith('shutdown');

    const sink = new LogSink({
      send: (lines) => api.appendLog(op.operationId, lines),
      flushMs: this.deps.logFlushMs,
      onError: (error) => {
        if (isOperationLost(error)) stopWith('lost');
      },
    });
    const heartbeat = setInterval(() => {
      api
        .reportState(op.operationId, { state: 'in_progress' })
        .catch((error: unknown) => isOperationLost(error) && stopWith('lost'));
    }, this.deps.heartbeatMs);

    let report: Report;
    let outcomeCode = 'succeeded';
    try {
      const outcome = await this.deps.operations.execute(op, {
        signal: abort.signal,
        log: (stream, text) => sink.write(stream, text),
      });
      report = { state: 'succeeded', ...(outcome.runtime ? { runtime: outcome.runtime } : {}) };
    } catch (error) {
      if (isOperationLost(error)) stopWith('lost');
      const failure = this.failureOf(error, reason);
      outcomeCode = failure?.code ?? 'lost';
      report = failure ? { state: 'failed', failure } : { state: 'failed' };
    } finally {
      clearInterval(heartbeat);
      this.current = null;
    }

    await sink.flush().catch((error: unknown) => isOperationLost(error) && stopWith('lost'));
    if (reason === 'lost') {
      logger.event('operation_lost', fields);
      return;
    }
    await this.report(op.operationId, fields, report);
    logger.event('operation_finished', { ...fields, outcome: outcomeCode });
  }

  /** The failure to report for an error, or `undefined` when the operation was lost. */
  private failureOf(error: unknown, reason: AbortReason | null): Report['failure'] | undefined {
    if (reason === 'lost' || isOperationLost(error)) return undefined;
    if (reason === 'shutdown' || error instanceof OperationAborted) {
      return {
        code: 'controller_stopped',
        detail: 'The controller was stopped.',
        ...(error instanceof OperationAborted && error.previewRemoved
          ? { previewRemoved: true }
          : {}),
      };
    }
    if (error instanceof OperationFailure) {
      return {
        code: error.code,
        detail: error.message.slice(0, PREVIEW_FAILURE_DETAIL_MAX_LENGTH),
        ...(error.refusals
          ? { refusals: error.refusals.slice(0, PREVIEW_FAILURE_REFUSALS_MAX) }
          : {}),
        ...(error.previewRemoved ? { previewRemoved: true } : {}),
      };
    }
    return { code: 'controller_error', detail: 'The controller hit an unexpected error.' };
  }

  /** The final report, retried on transient errors; a 404 or 409 ends it. */
  private async report(
    operationId: string,
    fields: { operationId: string; projectId: string; kind: string } | undefined,
    report: Report,
  ): Promise<void> {
    const { attempts, delayMs } = this.deps.report ?? { attempts: 6, delayMs: 1000 };
    let wait = delayMs;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.deps.api.reportState(operationId, report);
        return;
      } catch (error) {
        if (!isTransient(error) || attempt === attempts) {
          this.deps.logger.event('report_failed', {
            ...fields,
            operationId,
            outcome: error instanceof StudioApiError ? `http_${error.status}` : 'unreachable',
          });
          return;
        }
        await delay(wait);
        wait = Math.min(wait * 2, 15_000);
      }
    }
  }
}
