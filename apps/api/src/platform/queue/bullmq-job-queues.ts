import { randomUUID } from 'node:crypto';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
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

/** Every queue key starts with this, so queues cannot collide with session or other keys. */
export const QUEUE_KEY_PREFIX = 'studio:queue';

const QUEUE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// BullMQ rejects integer-like custom ids and uses `:` as its key separator.
const JOB_ID = /^(?!\d+$)[A-Za-z0-9._-]{1,200}$/;
// States in which a job with the same id blocks a new one.
const UNFINISHED_STATES = new Set([
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
]);
// States in which cancel() removes a job before it runs.
const CANCELLABLE_WAITING_STATES = new Set(['waiting', 'delayed', 'prioritized']);
const HEALTH_TIMEOUT_MS = 1_000;
// Aborted jobs settle at once, so a healthy close is fast; this only bounds a dead Redis.
const CLOSE_TIMEOUT_MS = 5_000;

/** What is stored in Redis per job: the owner's payload plus platform bookkeeping. */
interface StoredJob {
  payload: JobPayload;
  /** Unique per enqueue call; tells our job apart from a concurrent duplicate. */
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
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly logger = new Logger('JobQueues');
  private readonly producer: Redis;
  private readonly entries = new Map<string, Entry>();
  private bootstrapped = false;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
    this.producer = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    // Failures surface as typed errors from enqueue/cancel and in the health check.
    this.producer.on('error', () => {});
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
    queue.on('error', (error) => this.logError(definition.name, error));
    const entry: Entry = {
      definition: definition as unknown as QueueDefinition<JobPayload>,
      queue,
      running: new Map(),
    };
    this.entries.set(definition.name, entry);
    return {
      enqueue: (id, payload, options) => this.enqueue(entry, id, payload, options),
      cancel: (id) => this.cancel(entry, id),
    };
  }

  /** True if the queue's Redis answers within HEALTH_TIMEOUT_MS. */
  async isAvailable(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), HEALTH_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        this.producer.ping().then(
          (reply) => reply === 'PONG',
          () => false,
        ),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
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
   * run them a second time.
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
      // once, so `undefined` means ours already ran.
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
      if (!job || !CANCELLABLE_WAITING_STATES.has(await job.getState())) {
        return false;
      }
      try {
        await job.remove();
        return true;
      } catch {
        // It started meanwhile (our worker holds its lock): abort it instead.
        return this.abortRunning(entry, id);
      }
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
    entry.workerConnection.on('error', () => {});
    entry.worker = new Worker<StoredJob>(definition.name, (job) => this.run(entry, job), {
      connection: entry.workerConnection,
      prefix: QUEUE_KEY_PREFIX,
      concurrency: definition.concurrency ?? 1,
      // A stalled job fails instead of running a second time (attempts stay at 1).
      maxStalledCount: 0,
    });
    entry.worker.on('error', (error) => this.logError(definition.name, error));
  }

  /**
   * The processor wrapper: one AbortController per running job, fired by cancel(), the
   * time limit or shutdown. An aborted job settles at once even if its processor ignores
   * the signal, and its owner hears about every failure exactly once.
   */
  private async run(entry: Entry, job: Job<StoredJob>): Promise<void> {
    const { definition, running } = entry;
    const id = job.id!;
    const { payload, timeoutMs = definition.timeoutMs } = job.data;
    const controller = new AbortController();
    running.set(id, controller);
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort(new JobAbortedError('timeout')), timeoutMs);
    try {
      await untilAborted(
        definition.process({ id, payload, signal: controller.signal }),
        controller.signal,
      );
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
      this.logError(entry.definition.name, error);
    }
  }

  /** Waits for `operation`, but at most CLOSE_TIMEOUT_MS, so shutdown never hangs. */
  private async bounded(operation: Promise<unknown>, what: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS);
    });
    try {
      if ((await Promise.race([operation, timedOut])) === 'timeout') {
        this.logger.warn(`Gave up ${what} after ${CLOSE_TIMEOUT_MS} ms.`);
      }
    } catch (error) {
      this.logger.warn(`Failed ${what}: ${redactSecrets(errorMessage(error))}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private logError(queue: string, error: unknown): void {
    this.logger.warn(`Queue "${queue}": ${redactSecrets(errorMessage(error))}`);
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

/** Settles with `work`, or rejects as soon as `signal` aborts, whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // A processor that ignores the signal may still reject later; nobody listens then.
  work.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
