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
  type EnqueueOptions,
  JobAbortedError,
  JobAlreadyActiveError,
  type JobFailure,
  type JobPayload,
  type JobQueue,
  JobQueues,
  type QueueDefinition,
  type QueuedJob,
  QueueUnavailableError,
} from './job-queue.js';
import type { QueueHealth } from './queue-health.js';

/** Every queue key starts with this, so queues cannot collide with session or other keys. */
export const QUEUE_KEY_PREFIX = 'studio:queue';

const QUEUE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// BullMQ rejects integer-like custom ids and uses `:` as its key separator.
const JOB_ID = /^(?!\d+$)[A-Za-z0-9._-]{1,200}$/;
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
const TIMED_OUT = Symbol('timed out');

/** What is stored in Redis per job: the owner's payload plus platform bookkeeping. */
interface StoredJob {
  payload: JobPayload;
  /** Unique per enqueue call; tells this job apart from any other run with the same id. */
  token: string;
  timeoutMs?: number;
}

interface Entry {
  definition: QueueDefinition<JobPayload>;
  queue: Queue<StoredJob>;
  worker?: Worker<StoredJob>;
  workerConnection?: Redis;
  /** Abort controllers of the jobs this process is running, by job id. */
  running: Map<string, AbortController>;
  /** Tokens of jobs cancelled after BullMQ took them but before their processor started. */
  cancelledBeforeStart: Set<string>;
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

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
    this.producer = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
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
    const queue = new Queue<StoredJob>(definition.name, {
      connection: this.producer,
      prefix: QUEUE_KEY_PREFIX,
      defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
    });
    // Connection errors are logged once per outage by logConnectionErrors.
    queue.on('error', () => {});
    const entry: Entry = {
      definition: definition as unknown as QueueDefinition<JobPayload>,
      queue,
      running: new Map(),
      cancelledBeforeStart: new Set(),
    };
    this.entries.set(definition.name, entry);
    return {
      enqueue: (id, payload, options) => this.enqueue(entry, id, payload, options),
      cancel: (id) => this.cancel(entry, id),
    };
  }

  async isAvailable(): Promise<boolean> {
    const reply = await withTimeout(
      this.producer.ping().catch(() => undefined),
      HEALTH_TIMEOUT_MS,
    );
    return reply === 'PONG';
  }

  /** Reconciles interrupted jobs, then starts the workers. */
  async onApplicationBootstrap(): Promise<void> {
    this.bootstrapped = true;
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
        for (const controller of entry.running.values()) {
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
    const { queue, definition } = entry;
    const stored: StoredJob = { payload, token: randomUUID(), timeoutMs: options.timeoutMs };
    const added = await unavailableOnError(async () => {
      const existing = await queue.getJob(id);
      if (existing && UNFINISHED_STATES.has(await existing.getState())) {
        return false;
      }
      // BullMQ ignores an add whose id exists (it returns no error), so read the job back:
      // a different token means a concurrent enqueue won. Finished jobs are removed at
      // once, so `undefined` normally means ours already ran. (Known gap: it can also mean
      // a concurrent rival with the same id ran and finished in between.)
      await queue.add(definition.name, stored, { jobId: id });
      const current = await queue.getJob(id);
      return current === undefined || current.data.token === stored.token;
    });
    if (!added) {
      throw new JobAlreadyActiveError(definition.name, id);
    }
  }

  private async cancel(entry: Entry, id: string): Promise<boolean> {
    assertJobId(id);
    if (this.abortRunning(entry, id)) {
      return true;
    }
    return unavailableOnError(async () => {
      const job = await entry.queue.getJob(id);
      if (!job) {
        return false;
      }
      const state = await job.getState();
      if (WAITING_STATES.has(state)) {
        try {
          await job.remove();
          return true;
        } catch {
          // Our worker took it meanwhile (it holds the lock).
        }
      } else if (state !== 'active' || !this.bootstrapped) {
        return false;
      }
      // Active here means our worker has taken it; abort it now or as soon as it starts.
      if (!this.abortRunning(entry, id)) {
        entry.cancelledBeforeStart.add(job.data.token);
      }
      return true;
    });
  }

  private abortRunning(entry: Entry, id: string): boolean {
    const controller = entry.running.get(id);
    controller?.abort(new JobAbortedError('cancelled'));
    return controller !== undefined;
  }

  private startWorker(entry: Entry): void {
    const { definition } = entry;
    entry.workerConnection = new Redis(this.config.redisUrl, { maxRetriesPerRequest: null });
    this.logConnectionErrors(entry.workerConnection, `worker "${definition.name}"`);
    entry.worker = new Worker<StoredJob>(definition.name, (job) => this.run(entry, job), {
      connection: entry.workerConnection,
      prefix: QUEUE_KEY_PREFIX,
      concurrency: definition.concurrency ?? 1,
      // A stalled job fails instead of running a second time (attempts stay at 1).
      maxStalledCount: 0,
    });
    // Connection errors are logged once per outage by logConnectionErrors.
    entry.worker.on('error', () => {});
  }

  /**
   * The processor wrapper: one AbortController per running job, fired by cancel(), the
   * time limit or shutdown. The job (and so its id and worker slot) stays active until
   * the processor settles, so a processor that ignores the signal cannot overlap a new
   * run with the same id; its owner hears about every failure exactly once, afterwards.
   */
  private async run(entry: Entry, job: Job<StoredJob>): Promise<void> {
    const { definition, running, cancelledBeforeStart } = entry;
    const id = job.id!;
    const { payload, token, timeoutMs = definition.timeoutMs } = job.data;
    const controller = new AbortController();
    running.set(id, controller);
    if (cancelledBeforeStart.delete(token)) {
      controller.abort(new JobAbortedError('cancelled'));
    }
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(new JobAbortedError('timeout')), timeoutMs);
    try {
      await definition.process({ id, payload, signal: controller.signal });
    } catch (error) {
      const failure: JobFailure =
        controller.signal.reason instanceof JobAbortedError
          ? { reason: controller.signal.reason.reason }
          : { reason: 'error', error };
      await this.report(entry, { id, payload }, failure);
      // Tells BullMQ the job failed; the owner already has the real error.
      throw new Error(`Job failed: ${failure.reason}`);
    } finally {
      clearTimeout(timer);
      running.delete(id);
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

function assertJobId(id: string): void {
  if (!JOB_ID.test(id)) {
    throw new Error(`Invalid job id "${id}".`);
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
