import { setTimeout as delay } from 'node:timers/promises';
import { isRunLost, isTransient } from './studio-api.js';

/** How long the outbox waits before it tries a failed delivery again: doubling, up to a cap. */
export interface Backoff {
  initialMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { initialMs: 1000, maxMs: 30_000 };

/**
 * Most reports one Run's outbox holds. A Run step produces at most three (running, the step
 * result, the end state), so the bound is never reached in normal operation; it keeps memory
 * bounded however long Studio stays away.
 */
export const OUTBOX_MAX_PENDING = 16;

export interface ReportOutboxOptions {
  /** Aborted when the worker shuts down: delivery stops, and what is left is dropped. */
  signal: AbortSignal;
  backoff?: Backoff;
  maxPending?: number;
  /** Studio says this worker no longer holds the Run (409, 404): what is left is dropped. */
  onLost: () => void;
  logger: { error(message: string): void };
}

interface Report {
  label: string;
  send: (signal: AbortSignal) => Promise<void>;
}

/** The outbox already holds {@link OUTBOX_MAX_PENDING} reports. */
export class OutboxFullError extends Error {
  constructor(limit: number) {
    super(`More than ${limit} reports are waiting for Studio.`);
    this.name = 'OutboxFullError';
  }
}

/**
 * One Run's state and step reports on their way to Studio, delivered in order: while Studio is
 * failing a report is retried with backoff and the ones after it wait. A report Studio refuses for
 * good is dropped; a "not held" answer drops everything left.
 */
export class ReportOutbox {
  private readonly queue: Report[] = [];
  private delivering: Promise<void> | undefined;
  private lostRun = false;

  constructor(private readonly options: ReportOutboxOptions) {}

  /** Whether Studio said this worker no longer holds the Run. */
  get lost(): boolean {
    return this.lostRun;
  }

  /** Queues a report; throws {@link OutboxFullError} when the bound is reached. */
  send(label: string, send: (signal: AbortSignal) => Promise<void>): void {
    if (this.lostRun) return;
    const limit = this.options.maxPending ?? OUTBOX_MAX_PENDING;
    if (this.queue.length >= limit) throw new OutboxFullError(limit);
    this.queue.push({ label, send });
    this.kick();
  }

  /** Resolves once every queued report is delivered, dropped, or the worker stops. */
  async drain(): Promise<void> {
    while (this.delivering) await this.delivering;
  }

  private kick(): void {
    this.delivering ??= this.deliver().finally(() => {
      this.delivering = undefined;
      if (this.queue.length > 0 && !this.lostRun && !this.options.signal.aborted) this.kick();
    });
  }

  private async deliver(): Promise<void> {
    const { signal, logger } = this.options;
    const backoff = this.options.backoff ?? DEFAULT_BACKOFF;
    let waitMs = backoff.initialMs;
    while (this.queue.length > 0 && !this.lostRun && !signal.aborted) {
      const report = this.queue[0]!;
      try {
        await report.send(signal);
        this.queue.shift();
        waitMs = backoff.initialMs;
      } catch (error) {
        if (isRunLost(error)) {
          this.lostRun = true;
          this.queue.length = 0;
          this.options.onLost();
          return;
        }
        if (signal.aborted) return;
        if (!isTransient(error)) {
          logger.error(
            `Studio refused the ${report.label} report; dropping it: ${describe(error)}`,
          );
          this.queue.shift();
          continue;
        }
        logger.error(
          `Studio is unreachable (${describe(error)}); the ${report.label} report and ` +
            `${this.queue.length - 1} after it wait, retrying in ${Math.round(waitMs / 1000)} s.`,
        );
        try {
          await delay(waitMs, undefined, { signal });
        } catch {
          return;
        }
        waitMs = Math.min(waitMs * 2, backoff.maxMs);
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
