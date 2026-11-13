// The queue port business modules use. It never imports BullMQ or Redis, so a feature
// handler can depend on it without reaching a concrete client (architecture:api).

/**
 * A job payload: identifiers only, never secrets or secret values. Flat JSON primitives
 * keep it serialisable and make it awkward to smuggle whole objects into Redis.
 */
export type JobPayload = Readonly<Record<string, string | number | boolean | null>>;

/** A job as its owner sees it: the caller-supplied id and the payload. */
export interface QueuedJob<P extends JobPayload> {
  readonly id: string;
  readonly payload: P;
}

/** A job being processed. The signal aborts on cancel, timeout or shutdown. */
export interface RunningJob<P extends JobPayload> extends QueuedJob<P> {
  readonly signal: AbortSignal;
}

/** Why a running job was aborted. */
export type JobAbortReason = 'cancelled' | 'timeout' | 'shutdown';

/** The `signal.reason` a processor sees when its job is aborted. */
export class JobAbortedError extends Error {
  constructor(readonly reason: JobAbortReason) {
    super(`Job aborted: ${reason}`);
    this.name = 'JobAbortedError';
  }
}

/** Why a job that started processing did not succeed. `error` is the processor's own throw. */
export type JobFailure = { reason: 'error'; error: unknown } | { reason: JobAbortReason };

/**
 * What a business module registers: a named queue, its processor and the hooks through
 * which the platform reports outcomes. Jobs run at most once (no automatic retries).
 */
export interface QueueDefinition<P extends JobPayload> {
  /** Lower-case letters, digits and dashes; unique per application. */
  readonly name: string;
  /**
   * Runs one job and must stop promptly when `job.signal` aborts (e.g. kill its child
   * process). The job, its id and its worker slot stay busy until this settles, and
   * `onFailed` is called only afterwards, so no late write can follow the failure report.
   */
  process(job: RunningJob<P>): Promise<void>;
  /** Called once when a job fails, is cancelled while running, times out or is cut off by shutdown. */
  onFailed(job: QueuedJob<P>, failure: JobFailure): Promise<void>;
  /**
   * Called on startup, before any job of this queue runs, with the jobs that were running
   * when the previous process died. They are then discarded and never re-run. If this
   * throws, application startup fails and the jobs are offered again on the next start.
   */
  reconcile(interrupted: QueuedJob<P>[]): Promise<void>;
  /** Default per-job time limit in milliseconds; none if omitted. */
  readonly timeoutMs?: number;
  /** Jobs processed in parallel by this process; default 1. */
  readonly concurrency?: number;
}

export interface EnqueueOptions {
  /** Overrides the queue's default time limit for this job, in milliseconds. */
  readonly timeoutMs?: number;
}

/** The handle a module gets back from {@link JobQueues.register}. */
export interface JobQueue<P extends JobPayload> {
  /**
   * Adds a job under a deterministic, caller-supplied id (letters, digits, `.`, `_`, `-`;
   * not all digits). A finished job with the same id does not block a new one.
   * @throws JobAlreadyActiveError if a job with this id is waiting or running.
   * @throws QueueUnavailableError if Redis cannot be reached.
   */
  enqueue(id: string, payload: P, options?: EnqueueOptions): Promise<void>;
  /**
   * Cancels a job: a running job's signal aborts (its owner gets `onFailed` with
   * `cancelled`); a waiting job is removed without running. Returns false if there was
   * nothing to cancel.
   * @throws QueueUnavailableError if Redis cannot be reached.
   */
  cancel(id: string): Promise<boolean>;
}

/**
 * Registers queues. Inject it and call {@link register} during module initialisation
 * (a provider factory or `onModuleInit`); workers start once the application has bootstrapped.
 */
export abstract class JobQueues {
  abstract register<P extends JobPayload>(definition: QueueDefinition<P>): JobQueue<P>;
}

/** A job with the same id is already waiting or running; an HTTP caller maps it to 409. */
export class JobAlreadyActiveError extends Error {
  constructor(
    readonly queue: string,
    readonly jobId: string,
  ) {
    super(`A job with id "${jobId}" is already waiting or running in queue "${queue}".`);
    this.name = 'JobAlreadyActiveError';
  }
}

/** The queue's Redis could not be reached; the job was not enqueued or cancelled. */
export class QueueUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The job queue is unavailable.', options);
    this.name = 'QueueUnavailableError';
  }
}
