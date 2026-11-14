import { randomUUID } from 'node:crypto';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type Job, type JobState, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { redactSecrets } from '../http/redact.js';
import {
  type CancelOptions,
  type EnqueueOptions,
  JobAbortedError,
  JobAlreadyActiveError,
  type JobFailure,
  type JobPayload,
  type JobQueue,
  JobQueues,
  type QueueDefinition,
  JobStillRunningError,
  type QueuedJob,
  QueueUnavailableError,
} from './job-queue.js';
import type { QueueHealth } from './queue-health.js';

/** Every queue key starts with this, so queues cannot collide with session or other keys. */
export const QUEUE_KEY_PREFIX = 'studio:queue';

/** Redis client name of every queue connection (visible in `CLIENT LIST`). */
export const QUEUE_CONNECTION_NAME = 'studio-queue';

/**
 * BullMQ worker timings. Production uses BullMQ's defaults (30 s lock, 30 s stalled check);
 * tests shorten them to exercise the lost-lock path.
 */
export interface QueueWorkerTuning {
  readonly lockDuration?: number;
  readonly stalledInterval?: number;
  /**
   * `false`: queues register, but bootstrap neither reconciles nor starts workers, so the app
   * needs no Redis to start. For offline builds that run no jobs: OpenAPI generation and
   * HTTP tests without Redis. Production always starts them (default `true`).
   */
  readonly startWorkers?: boolean;
}

/** DI token for {@link QueueWorkerTuning}. */
export const QUEUE_WORKER_TUNING = Symbol('QUEUE_WORKER_TUNING');

const QUEUE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// BullMQ rejects integer-like custom ids and uses `:` as its key separator.
const JOB_ID = /^(?!\d+$)[A-Za-z0-9._-]{1,200}$/;
// The largest delay a Node.js timer supports; anything above fires after ~1 ms.
const MAX_TIMEOUT_MS = 2_147_483_647;
type State = JobState | 'unknown';
// States in which a job with the same id blocks a new one.
const UNFINISHED_STATES: ReadonlySet<State> = new Set<State>([
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
]);
// States in which cancel() removes a job before it runs.
const WAITING_STATES: ReadonlySet<State> = new Set<State>(['waiting', 'delayed', 'prioritized']);
const HEALTH_TIMEOUT_MS = 1_000;
// Bounds shutdown when Redis is dead or a processor ignores its abort signal.
const CLOSE_TIMEOUT_MS = 5_000;
// How long cancel() waits for a job our worker has taken to reach its processor.
const START_WAIT_MS = 1_000;
const START_POLL_MS = 10;
// How often cancel() checks that BullMQ has finished a settled job (its id is free again).
const SETTLE_POLL_MS = 10;
const TIMED_OUT = Symbol('timed out');
// Errors that mean "Redis is unreachable"; logged once per outage by logConnectionErrors.
const CONNECTION_ERROR =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|Connection is closed|MaxRetriesPerRequest|Stream isn't writeable/i;

/** What is stored in Redis per job: the owner's payload plus platform bookkeeping. */
interface StoredJob {
  payload: JobPayload;
  /** Unique per enqueue call; tells this job apart from any other run with the same id. */
  token: string;
  timeoutMs?: number;
}

/** A job this process is running: its abort controller and the token of its enqueue. */
interface Run {
  controller: AbortController;
  token: string;
}

interface Entry {
  definition: QueueDefinition<JobPayload>;
  queue: Queue<StoredJob>;
  worker?: Worker<StoredJob>;
  workerConnection?: Redis;
  /**
   * The jobs this process is running, by job id. Authoritative for "running" (one API
   * instance): an id stays here until its processor settles, even if BullMQ has lost or
   * dropped the job meanwhile.
   */
  running: Map<string, Run>;
  /**
   * Per running job id: settles once its run is over (processor returned, `onFailed`
   * completed, the id left `running`). What `cancel` with `settleTimeoutMs` waits for.
   */
  settled: Map<string, Promise<void>>;
}

/**
 * {@link JobQueues} on BullMQ. Processors run inside the API process. Producers share one
 * fail-fast connection; each worker gets its own (BullMQ requires `maxRetriesPerRequest:
 * null` there). Nothing connects to Redis until a queue is used, so building the app
 * (tests, OpenAPI generation) needs no Redis.
 */
@Injectable()
export class BullMqJobQueues
  extends JobQueues
  implements QueueHealth, OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger('JobQueues');
  private readonly producer: Redis;
  private readonly entries = new Map<string, Entry>();
  private bootstrapped = false;
  /** Whether the last health ping timed out; the first timeout of an outage is logged, once. */
  private healthPingTimedOut = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(QUEUE_WORKER_TUNING) private readonly tuning: QueueWorkerTuning,
  ) {
    super();
    this.producer = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectionName: QUEUE_CONNECTION_NAME,
    });
    this.logConnectionErrors(this.producer, 'producer');
  }

  register<P extends JobPayload>(definition: QueueDefinition<P>): JobQueue<P> {
    if (this.bootstrapped) {
      throw new Error('Queues must be registered during module initialisation.');
    }
    if (!QUEUE_NAME.test(definition.name)) {
      throw new Error(`Invalid queue name "${definition.name}".`);
    }
    if (this.entries.has(definition.name)) {
      throw new Error(`Queue "${definition.name}" is already registered.`);
    }
    assertTimeout(definition.timeoutMs);
    if (
      definition.concurrency !== undefined &&
      !(Number.isInteger(definition.concurrency) && definition.concurrency >= 1)
    ) {
      throw new Error(`Invalid concurrency ${definition.concurrency}: must be an integer ≥ 1.`);
    }
    const queue = new Queue<StoredJob>(definition.name, {
      connection: this.producer,
      prefix: QUEUE_KEY_PREFIX,
      defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
    });
    queue.on('error', (error) => this.logBullMqError(definition.name, error));
    const entry: Entry = {
      definition: definition as unknown as QueueDefinition<JobPayload>,
      queue,
      running: new Map(),
      settled: new Map(),
    };
    this.entries.set(definition.name, entry);
    return {
      enqueue: (id, payload, options) => this.enqueue(entry, id, payload, options),
      cancel: (id, options) => this.cancel(entry, id, options),
    };
  }

  /**
   * Pings the queue's Redis. A probe calls this every few seconds, so a ping that times out
   * while connected (Redis slow, not down) is logged once per outage and the recovery once.
   * While the producer is not connected, a ping waits in the offline queue and times out
   * too; that is the connection outage logConnectionErrors already logs, so not logged here.
   */
  async isAvailable(): Promise<boolean> {
    const reply = await withTimeout(
      this.producer.ping().catch(() => undefined),
      HEALTH_TIMEOUT_MS,
    );
    // Check and update in one synchronous step, so concurrent probes log at most once.
    if (reply === 'PONG') {
      if (this.healthPingTimedOut) this.logger.log('Queue Redis health check passes again.');
      this.healthPingTimedOut = false;
    } else if (
      reply === TIMED_OUT &&
      this.producer.status === 'ready' &&
      !this.healthPingTimedOut
    ) {
      this.healthPingTimedOut = true;
      this.logger.warn(
        `Queue Redis health check failed: no answer within ${HEALTH_TIMEOUT_MS} ms.`,
      );
    }
    return reply === 'PONG';
  }

  /**
   * Reconciles interrupted jobs, then starts the workers, once. Nest calls the hook once per
   * provider that resolves to this instance (e.g. the health module's `QueueHealth` alias
   * too); a second run would start a second worker that shutdown never closes.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    this.bootstrapped = true;
    if (this.tuning.startWorkers === false) return;
    for (const entry of this.entries.values()) {
      await this.reconcile(entry);
      this.startWorker(entry);
    }
  }

  /**
   * Jobs still `active` at startup belonged to a process that died: processors run only in
   * the API process, and there is one API instance (MVP). The owner hears about them first;
   * then they are removed (their stale lock included) so BullMQ's stalled-job check cannot
   * run them a second time. If the owner's hook throws, startup fails and the jobs stay
   * for the next start.
   */
  private async reconcile(entry: Entry): Promise<void> {
    const { queue, definition } = entry;
    const interrupted = await unavailableOnError(() => queue.getActive());
    await definition.reconcile(
      interrupted.map((job) => ({ id: job.id!, payload: job.data.payload })),
    );
    await unavailableOnError(async () => {
      for (const job of interrupted) {
        await this.producer.del(`${queue.toKey(job.id!)}:lock`);
        await job.remove();
      }
    });
  }

  /**
   * Stops taking jobs and aborts the running ones, so their owners hear `shutdown` while
   * the rest of the app (e.g. the database client) is still up.
   */
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        if (!entry.worker) return;
        // close() stops fetching at once and waits for the running jobs, which the aborts end.
        const closing = entry.worker.close();
        for (const { controller } of entry.running.values()) {
          controller.abort(new JobAbortedError('shutdown'));
        }
        await this.bounded(closing, `stopping worker "${entry.definition.name}"`);
      }),
    );
  }

  /** Closes every Redis connection this service opened. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((entry) =>
        this.bounded(entry.queue.close(), `closing queue "${entry.definition.name}"`),
      ),
    );
    for (const entry of this.entries.values()) {
      // Also drops the worker's own blocking connection if a dead Redis stalled close().
      void entry.worker?.disconnect().catch(() => {});
      entry.workerConnection?.disconnect();
    }
    this.producer.disconnect();
  }

  private async enqueue(
    entry: Entry,
    id: string,
    payload: JobPayload,
    options: EnqueueOptions = {},
  ): Promise<void> {
    assertJobId(id);
    assertTimeout(options.timeoutMs);
    const { queue, definition } = entry;
    // A processor that is still running here owns the id, whatever Redis says (lost lock).
    if (entry.running.has(id)) {
      throw new JobAlreadyActiveError(definition.name, id);
    }
    const stored: StoredJob = { payload, token: randomUUID(), timeoutMs: options.timeoutMs };
    const added = await unavailableOnError(async () => {
      const existing = await queue.getJob(id);
      if (existing) {
        if (UNFINISHED_STATES.has(await existing.getState())) {
          return false;
        }
        // A finished (or orphaned) leftover would make BullMQ ignore the add below.
        await existing.remove();
      }
      // BullMQ ignores an add whose id exists (it returns no error), so read the job back:
      // a different token means a concurrent enqueue won. Finished jobs are removed at
      // once, so `undefined` normally means ours already ran (see the port's race note).
      await queue.add(definition.name, stored, { jobId: id });
      const current = await queue.getJob(id);
      return current === undefined || current.data.token === stored.token;
    });
    if (!added) {
      throw new JobAlreadyActiveError(definition.name, id);
    }
  }

  private async cancel(entry: Entry, id: string, options: CancelOptions = {}): Promise<boolean> {
    assertJobId(id);
    assertTimeout(options.settleTimeoutMs);
    const cancelled = await this.signalCancel(entry, id);
    if (cancelled && options.settleTimeoutMs !== undefined) {
      await this.waitUntilSettled(entry, id, Date.now() + options.settleTimeoutMs);
    }
    return cancelled;
  }

  /**
   * Waits until the cancelled job's run is over in this process and BullMQ no longer holds
   * the id as unfinished (it moves a failed job out of `active` just after the processor
   * returns), so the id is free for a new job.
   */
  private async waitUntilSettled(entry: Entry, id: string, deadline: number): Promise<void> {
    const { definition, queue } = entry;
    const settled = entry.settled.get(id);
    if (settled && (await withTimeout(settled, deadline - Date.now())) === TIMED_OUT) {
      throw new JobStillRunningError(definition.name, id);
    }
    for (;;) {
      const busy = await unavailableOnError(async () => {
        const job = await queue.getJob(id);
        return job !== undefined && UNFINISHED_STATES.has(await job.getState());
      });
      // A new run of the same id (another caller's enqueue) is not ours to wait for.
      if (!busy || entry.running.has(id)) return;
      if (Date.now() >= deadline) throw new JobStillRunningError(definition.name, id);
      await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
  }

  /** Signals the cancel (abort, or removal of a waiting job); true if there was a job to cancel. */
  private async signalCancel(entry: Entry, id: string): Promise<boolean> {
    if (this.abortRunning(entry, id)) {
      return true;
    }
    const found = await unavailableOnError(async () => {
      const job = await entry.queue.getJob(id);
      if (!job) {
        return undefined;
      }
      const token = job.data.token;
      const current = await job.getState();
      if (WAITING_STATES.has(current)) {
        try {
          await job.remove();
          return { state: 'removed' as const, token };
        } catch {
          // Our worker took it meanwhile (it holds the lock).
          return { state: 'active' as const, token };
        }
      }
      return { state: current, token };
    });
    if (found?.state === 'removed') {
      return true;
    }
    if (found?.state !== 'active' || !this.bootstrapped) {
      return false;
    }
    // Active but not running here: either our worker has just taken it and is about to
    // call its processor (wait for that, then abort with a live signal), or it is held by
    // something we cannot abort or has just finished (then there is nothing to cancel).
    // Only the run of this enqueue (its token) is ours: a newer run with the same id that
    // starts meanwhile means this job is over, and is never aborted.
    const deadline = Date.now() + START_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
      const run = entry.running.get(id);
      if (run) {
        if (run.token !== found.token) return false;
        run.controller.abort(new JobAbortedError('cancelled'));
        return true;
      }
    }
    return false;
  }

  private abortRunning(entry: Entry, id: string): boolean {
    const run = entry.running.get(id);
    run?.controller.abort(new JobAbortedError('cancelled'));
    return run !== undefined;
  }

  private startWorker(entry: Entry): void {
    const { definition, running } = entry;
    entry.workerConnection = new Redis(this.config.redisUrl, {
      maxRetriesPerRequest: null,
      connectionName: QUEUE_CONNECTION_NAME,
    });
    this.logConnectionErrors(entry.workerConnection, `worker "${definition.name}"`);
    entry.worker = new Worker<StoredJob>(definition.name, (job) => this.run(entry, job), {
      connection: entry.workerConnection,
      prefix: QUEUE_KEY_PREFIX,
      concurrency: definition.concurrency ?? 1,
      // A stalled job fails instead of running a second time (attempts stay at 1).
      maxStalledCount: 0,
      ...this.tuning,
    });
    entry.worker.on('error', (error) => this.logBullMqError(definition.name, error));
    // The lock of a job we are still running was lost (e.g. a Redis outage longer than
    // the lock): BullMQ fails it. Abort the processor; the id stays busy until it settles.
    entry.worker.on('stalled', (jobId) => {
      this.logger.warn(`Queue "${definition.name}": job "${jobId}" lost its lock (stalled).`);
      running.get(jobId)?.controller.abort(new JobAbortedError('stalled'));
    });
  }

  /**
   * The processor wrapper: one AbortController per running job, fired by cancel(), the
   * time limit, a lost lock or shutdown. The job (and so its id and worker slot) stays
   * busy until the processor settles; an aborted job is a failure even if the processor
   * resolves, and its owner hears about every failure exactly once, afterwards.
   */
  private async run(entry: Entry, job: Job<StoredJob>): Promise<void> {
    const { definition, running } = entry;
    const id = job.id!;
    const { payload, token, timeoutMs = definition.timeoutMs } = job.data;
    const controller = new AbortController();
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => (markSettled = resolve));
    running.set(id, { controller, token });
    entry.settled.set(id, settled);
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(new JobAbortedError('timeout')), timeoutMs);
    let failure: JobFailure | undefined;
    try {
      await definition.process({ id, payload, signal: controller.signal });
    } catch (error) {
      failure = { reason: 'error', error };
    } finally {
      clearTimeout(timer);
    }
    // An abort wins over the processor's own outcome (see JobFailure).
    if (controller.signal.reason instanceof JobAbortedError) {
      failure = { reason: controller.signal.reason.reason };
    }
    try {
      if (failure) {
        await this.report(entry, { id, payload }, failure);
        // Tells BullMQ the job failed; the owner already has the real error.
        throw new Error(`Job failed: ${failure.reason}`);
      }
    } finally {
      // Only our own entry: never a newer run's controller.
      if (running.get(id)?.controller === controller) {
        running.delete(id);
      }
      if (entry.settled.get(id) === settled) {
        entry.settled.delete(id);
      }
      markSettled();
    }
  }

  private async report(
    entry: Entry,
    job: QueuedJob<JobPayload>,
    failure: JobFailure,
  ): Promise<void> {
    try {
      await entry.definition.onFailed(job, failure);
    } catch (error) {
      this.logger.warn(
        `onFailed of queue "${entry.definition.name}" threw: ${redactSecrets(errorMessage(error))}`,
      );
    }
  }

  /** Waits for `operation`, but at most CLOSE_TIMEOUT_MS, so shutdown never hangs. */
  private async bounded(operation: Promise<unknown>, what: string): Promise<void> {
    try {
      if ((await withTimeout(operation, CLOSE_TIMEOUT_MS)) === TIMED_OUT) {
        this.logger.warn(`Gave up ${what} after ${CLOSE_TIMEOUT_MS} ms.`);
      }
    } catch (error) {
      this.logger.warn(`Failed ${what}: ${redactSecrets(errorMessage(error))}`);
    }
  }

  /** BullMQ errors other than "Redis unreachable" (e.g. lock failures) are logged, redacted. */
  private logBullMqError(queue: string, error: unknown): void {
    if (!isConnectionError(error)) {
      this.logger.warn(`Queue "${queue}": ${redactSecrets(errorMessage(error))}`);
    }
  }

  /** Logs the first error of an outage (redacted) and the recovery, not every retry. */
  private logConnectionErrors(connection: Redis, label: string): void {
    let down = false;
    connection.on('error', (error: unknown) => {
      if (!down) {
        down = true;
        this.logger.warn(
          `Queue Redis (${label}) unavailable: ${redactSecrets(errorMessage(error))}`,
        );
      }
    });
    connection.on('ready', () => {
      if (down) {
        down = false;
        this.logger.log(`Queue Redis (${label}) available again.`);
      }
    });
  }
}

function errorMessage(error: unknown): string {
  // An AggregateError (e.g. ECONNREFUSED on IPv4 and IPv6) has an empty message.
  return error instanceof Error ? error.message || error.name : String(error);
}

function isConnectionError(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return true;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return CONNECTION_ERROR.test(`${typeof code === 'string' ? code : ''} ${errorMessage(error)}`);
}

function assertJobId(id: string): void {
  if (!JOB_ID.test(id)) {
    throw new Error(`Invalid job id "${id}".`);
  }
}

function assertTimeout(timeoutMs: number | undefined): void {
  if (
    timeoutMs !== undefined &&
    !(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_TIMEOUT_MS)
  ) {
    throw new Error(
      `Invalid timeoutMs ${timeoutMs}: must be an integer from 1 to ${MAX_TIMEOUT_MS}.`,
    );
  }
}

/** Runs a Redis-backed operation; any failure means the queue is unavailable. */
async function unavailableOnError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new QueueUnavailableError({ cause: error });
  }
}

/** Settles with `operation`, or with TIMED_OUT once `ms` pass. */
async function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([operation, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
