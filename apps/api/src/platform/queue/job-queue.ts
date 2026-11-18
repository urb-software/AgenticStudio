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

/** A job being processed. The signal aborts on cancel, timeout, a lost lock or shutdown. */
export interface RunningJob<P extends JobPayload> extends QueuedJob<P> {
  readonly signal: AbortSignal;
}

/**
 * Why a running job was aborted. `stalled`: the queue lost the job's lock (e.g. a Redis
 * outage longer than the lock) and gave up on it; it is not re-run.
 */
export type JobAbortReason = 'cancelled' | 'timeout' | 'stalled' | 'shutdown';

/** The `signal.reason` a processor sees when its job is aborted. */
export class JobAbortedError extends Error {
  constructor(readonly reason: JobAbortReason) {
    super(`Job aborted: ${reason}`);
    this.name = 'JobAbortedError';
  }
}

/**
 * Why a job that started processing did not succeed. `error` is the processor's own throw.
 * Once a job has been aborted, the abort reason wins: an error thrown (or a value returned)
 * after the abort is reported as that reason, without the error.
 */
export type JobFailure = { reason: 'error'; error: unknown } | { reason: JobAbortReason };

/**
 * What a business module registers: a named queue, its processor and the hooks through
 * which the platform reports outcomes. Jobs run at most once (no automatic retries).
 */
export interface QueueDefinition<P extends JobPayload> {
  /** Lower-case letters, digits and dashes; unique per application. */
  readonly name: string;
  /**
   * Runs one job and must stop promptly when `job.signal` aborts. The job, its id and its
   * worker slot stay busy until this settles and `onFailed` runs only afterwards, so no late
   * write follows the failure report. Resolving after an abort still counts as a failure.
   */
  process(job: RunningJob<P>): Promise<void>;
  /**
   * Called once when a job fails, is cancelled while running, times out, loses its lock or
   * is cut off by shutdown.
   */
  onFailed(job: QueuedJob<P>, failure: JobFailure): Promise<void>;
  /**
   * Called on startup, before any job runs, with the jobs the previous process left running;
   * they are discarded, never re-run. If it throws, startup fails and they are offered again,
   * so it must be idempotent.
   */
  reconcile(interrupted: QueuedJob<P>[]): Promise<void>;
  /** Default per-job time limit in milliseconds (integer, 1 to 2^31−1); none if omitted. */
  readonly timeoutMs?: number;
  /** Jobs processed in parallel by this process (integer ≥ 1); default 1. */
  readonly concurrency?: number;
}

export interface EnqueueOptions {
  /** Overrides the queue's default time limit for this job, in milliseconds (1 to 2^31−1). */
  readonly timeoutMs?: number;
}

/** The handle a module gets back from {@link JobQueues.register}. */
export interface JobQueue<P extends JobPayload> {
  /**
   * Adds a job under a caller-supplied id (1–200 of `A-Za-z0-9._-`, not all digits); a
   * finished one does not block it, and racing enqueues can both succeed (owner state guards).
   * Throws JobAlreadyActiveError if waiting or running, QueueUnavailableError if no Redis.
   */
  enqueue(id: string, payload: P, options?: EnqueueOptions): Promise<void>;
  /**
   * Cancels a job (running: aborted, `onFailed` gets `cancelled`; waiting: removed); false if
   * nothing to cancel. `settleTimeoutMs` waits for processor, `onFailed` and a free id, else
   * JobStillRunningError; QueueUnavailableError when Redis is unreachable.
   */
  cancel(id: string, options?: CancelOptions): Promise<boolean>;
}

export interface CancelOptions {
  /**
   * Waits up to this long (milliseconds, 1 to 2^31−1) for a cancelled running job to settle.
   */
  readonly settleTimeoutMs?: number;
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

/**
 * A cancelled job did not settle in the time its canceller allowed (its processor ignores the
 * abort or is slow to stop). The job stays aborted and settles later on its own.
 */
export class JobStillRunningError extends Error {
  constructor(
    readonly queue: string,
    readonly jobId: string,
  ) {
    super(`The cancelled job "${jobId}" in queue "${queue}" is still running.`);
    this.name = 'JobStillRunningError';
  }
}

/** The queue's Redis could not be reached; the job was not enqueued or cancelled. */
export class QueueUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The job queue is unavailable.', options);
    this.name = 'QueueUnavailableError';
  }
}
