import { startRedis, type TestService } from '@agentic-studio/testing';
import {
  type INestApplicationContext,
  Injectable,
  Module,
  type OnModuleInit,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testConfig } from '../../../__tests__/test-config.js';
import { ConfigModule } from '../../config/config.module.js';
import {
  JobAbortedError,
  JobAlreadyActiveError,
  type JobFailure,
  type JobQueue,
  JobQueues,
  type QueueDefinition,
  type QueuedJob,
  QueueUnavailableError,
  type RunningJob,
} from '../job-queue.js';
import { QueueModule } from '../queue.module.js';

type Payload = { projectId: string };

/** A promise the test resolves by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Polls until `check` passes or the deadline expires (no fixed sleeps). */
async function eventually(check: () => void | Promise<void>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

/** A queue owner that records everything the platform tells it. */
class RecordingOwner implements QueueDefinition<Payload> {
  readonly processed: RunningJob<Payload>[] = [];
  readonly failures: { job: QueuedJob<Payload>; failure: JobFailure }[] = [];
  readonly reconciled: QueuedJob<Payload>[][] = [];
  /** Replace to change what the processor does. */
  behaviour: (job: RunningJob<Payload>) => Promise<void> = async () => {};

  constructor(
    readonly name: string,
    readonly timeoutMs?: number,
  ) {}

  async process(job: RunningJob<Payload>): Promise<void> {
    this.processed.push(job);
    await this.behaviour(job);
  }

  async onFailed(job: QueuedJob<Payload>, failure: JobFailure): Promise<void> {
    this.failures.push({ job, failure });
  }

  async reconcile(interrupted: QueuedJob<Payload>[]): Promise<void> {
    this.reconciled.push(interrupted);
  }
}

/** Builds an application context in which `owner` registers its queue, as a business module would. */
async function startApp(
  redisUrl: string,
  owner: RecordingOwner,
): Promise<{ app: INestApplicationContext; queue: JobQueue<Payload> }> {
  const handle: { queue?: JobQueue<Payload> } = {};

  @Injectable()
  class OwnerRegistration implements OnModuleInit {
    constructor(private readonly queues: JobQueues) {}
    onModuleInit(): void {
      handle.queue = this.queues.register(owner);
    }
  }

  @Module({
    imports: [ConfigModule.forRoot(testConfig({ redisUrl })), QueueModule],
    providers: [OwnerRegistration],
  })
  class TestRoot {}

  const app = await NestFactory.createApplicationContext(TestRoot, { logger: false });
  try {
    await app.init();
  } catch (error) {
    await app.close();
    throw error;
  }
  return { app, queue: handle.queue! };
}

describe('job queues (Redis via Testcontainers)', () => {
  let redisService: TestService;
  let redis: Redis;
  let app: INestApplicationContext | undefined;

  beforeAll(async () => {
    redisService = await startRedis();
    redis = new Redis(redisService.url);
  });

  afterAll(async () => {
    redis?.disconnect();
    await redisService?.stop();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('runs an enqueued job in the registered processor with its id and payload', async () => {
    const owner = new RecordingOwner('repository-sync');
    let queue: JobQueue<Payload>;
    ({ app, queue } = await startApp(redisService.url, owner));

    await queue.enqueue('sync-p1', { projectId: 'p1' });

    await eventually(() => {
      expect(owner.processed.map(({ id, payload }) => ({ id, payload }))).toEqual([
        { id: 'sync-p1', payload: { projectId: 'p1' } },
      ]);
    });
    expect(owner.failures).toEqual([]);
  });

  it('keeps every queue key under the studio:queue prefix, away from session keys', async () => {
    const owner = new RecordingOwner('repository-sync');
    const release = deferred();
    owner.behaviour = () => release.promise;
    let queue: JobQueue<Payload>;
    ({ app, queue } = await startApp(redisService.url, owner));

    await queue.enqueue('sync-p1', { projectId: 'p1' });
    await eventually(() => expect(owner.processed).toHaveLength(1));

    const keys = await redis.keys('*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !key.startsWith('studio:queue:repository-sync:'))).toEqual([]);
    release.resolve();
  });

  describe('deterministic job ids', () => {
    it('rejects an id that is already running or waiting with JobAlreadyActiveError', async () => {
      const owner = new RecordingOwner('repository-sync');
      const release = deferred();
      owner.behaviour = () => release.promise;
      let queue: JobQueue<Payload>;
      ({ app, queue } = await startApp(redisService.url, owner));

      await queue.enqueue('sync-p1', { projectId: 'p1' });
      await eventually(() => expect(owner.processed).toHaveLength(1));
      await queue.enqueue('sync-p2', { projectId: 'p2' }); // waits behind sync-p1

      await expect(queue.enqueue('sync-p1', { projectId: 'p1' })).rejects.toThrow(
        JobAlreadyActiveError,
      );
      await expect(queue.enqueue('sync-p2', { projectId: 'p2' })).rejects.toMatchObject({
        name: 'JobAlreadyActiveError',
        queue: 'repository-sync',
        jobId: 'sync-p2',
      });

      release.resolve();
      await eventually(() => expect(owner.processed).toHaveLength(2));
    });

    it('detects a concurrent duplicate that BullMQ would otherwise ignore silently', async () => {
      const owner = new RecordingOwner('repository-sync');
      const release = deferred();
      owner.behaviour = () => release.promise;
      let queue: JobQueue<Payload>;
      ({ app, queue } = await startApp(redisService.url, owner));

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => queue.enqueue('sync-p1', { projectId: 'p1' })),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results.filter((r) => r.status === 'rejected')) {
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(JobAlreadyActiveError);
      }
      release.resolve();
    });

    it('lets a finished job id run again', async () => {
      const owner = new RecordingOwner('repository-sync');
      let queue: JobQueue<Payload>;
      ({ app, queue } = await startApp(redisService.url, owner));

      await queue.enqueue('sync-p1', { projectId: 'p1' });
      await eventually(() => expect(owner.processed).toHaveLength(1));
      owner.behaviour = async () => {
        throw new Error('fetch failed');
      };
      await eventually(async () => {
        await queue.enqueue('sync-p1', { projectId: 'p1' });
      });
      await eventually(() => expect(owner.failures).toHaveLength(1));
      await eventually(async () => {
        await queue.enqueue('sync-p1', { projectId: 'p1' });
      });

      await eventually(() => expect(owner.processed).toHaveLength(3));
    });
  });

  it('runs a failing job once and reports the error to its owner', async () => {
    const owner = new RecordingOwner('repository-sync');
    const error = new Error('clone failed');
    owner.behaviour = async () => {
      throw error;
    };
    let queue: JobQueue<Payload>;
    ({ app, queue } = await startApp(redisService.url, owner));

    await queue.enqueue('sync-p1', { projectId: 'p1' });

    await eventually(() =>
      expect(owner.failures).toEqual([
        {
          job: { id: 'sync-p1', payload: { projectId: 'p1' } },
          failure: { reason: 'error', error },
        },
      ]),
    );
    // Give a retry the chance to happen; none may.
    await new Promise((r) => setTimeout(r, 500));
    expect(owner.processed).toHaveLength(1);
  });

  describe('cancel', () => {
    it('aborts a running job and reports it as cancelled', async () => {
      const owner = new RecordingOwner('repository-sync');
      owner.behaviour = (job) =>
        new Promise((_resolve, reject) =>
          job.signal.addEventListener('abort', () => reject(job.signal.reason)),
        );
      let queue: JobQueue<Payload>;
      ({ app, queue } = await startApp(redisService.url, owner));
      await queue.enqueue('sync-p1', { projectId: 'p1' });
      await eventually(() => expect(owner.processed).toHaveLength(1));

      await expect(queue.cancel('sync-p1')).resolves.toBe(true);

      const signal = owner.processed[0]!.signal;
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBeInstanceOf(JobAbortedError);
      expect(signal.reason).toMatchObject({ reason: 'cancelled' });
      await eventually(() =>
        expect(owner.failures).toEqual([
          {
            job: { id: 'sync-p1', payload: { projectId: 'p1' } },
            failure: { reason: 'cancelled' },
          },
        ]),
      );
    });

    it('removes a waiting job so it never runs', async () => {
      const owner = new RecordingOwner('repository-sync');
      const release = deferred();
      owner.behaviour = () => release.promise;
      let queue: JobQueue<Payload>;
      ({ app, queue } = await startApp(redisService.url, owner));
      await queue.enqueue('sync-p1', { projectId: 'p1' });
      await eventually(() => expect(owner.processed).toHaveLength(1));
      await queue.enqueue('sync-p2', { projectId: 'p2' });

      await expect(queue.cancel('sync-p2')).resolves.toBe(true);
      release.resolve();

      await queue.enqueue('sync-p3', { projectId: 'p3' });
      await eventually(() =>
        expect(owner.processed.map((job) => job.id)).toEqual(['sync-p1', 'sync-p3']),
      );
      expect(owner.failures).toEqual([]);
    });

    it('returns false when there is nothing to cancel', async () => {
      const owner = new RecordingOwner('repository-sync');
      let queue: JobQueue<Payload>;
      ({ app, queue } = await startApp(redisService.url, owner));

      await expect(queue.cancel('sync-unknown')).resolves.toBe(false);
    });
  });

  describe('time limit', () => {
    it("aborts a job when the queue's limit passes, even if the processor ignores the signal", async () => {
      const owner = new RecordingOwner('repository-sync', 200);
      owner.behaviour = () => new Promise(() => {}); // never settles, ignores the signal
      let queue: JobQueue<Payload>;
      ({ app, queue } = await startApp(redisService.url, owner));

      await queue.enqueue('sync-p1', { projectId: 'p1' });

      await eventually(() =>
        expect(owner.failures).toEqual([
          { job: { id: 'sync-p1', payload: { projectId: 'p1' } }, failure: { reason: 'timeout' } },
        ]),
      );
      expect(owner.processed[0]!.signal.reason).toMatchObject({ reason: 'timeout' });
      // The slot is free again: the next job runs.
      await queue.enqueue('sync-p2', { projectId: 'p2' });
      await eventually(() => expect(owner.processed).toHaveLength(2));
    });

    it('applies a per-job limit given at enqueue time', async () => {
      const owner = new RecordingOwner('repository-sync');
      owner.behaviour = () => new Promise(() => {});
      let queue: JobQueue<Payload>;
      ({ app, queue } = await startApp(redisService.url, owner));

      await queue.enqueue('sync-p1', { projectId: 'p1' }, { timeoutMs: 200 });

      await eventually(() => expect(owner.failures[0]?.failure).toEqual({ reason: 'timeout' }));
    });
  });

  describe('crash and reconcile', () => {
    it('hands jobs that were running when the process died to their owner, then discards them', async () => {
      // A "previous process" takes the job and dies without finishing it: its lock stays.
      const workerConnection = new Redis(redisService.url, { maxRetriesPerRequest: null });
      const producerConnection = new Redis(redisService.url);
      const crashed = new Worker('repository-sync', null, {
        connection: workerConnection,
        prefix: 'studio:queue',
      });
      const producer = new Queue('repository-sync', {
        connection: producerConnection,
        prefix: 'studio:queue',
      });
      await producer.add(
        'repository-sync',
        { payload: { projectId: 'p1' }, token: 'previous-process' },
        { jobId: 'sync-p1', attempts: 1 },
      );
      const taken = await crashed.getNextJob('crashed-token');
      expect(taken?.id).toBe('sync-p1');
      // Die without completing the job or releasing its lock.
      await crashed.close(true);
      await producer.close();
      workerConnection.disconnect();
      producerConnection.disconnect();

      const owner = new RecordingOwner('repository-sync');
      let queue: JobQueue<Payload>;
      ({ app, queue } = await startApp(redisService.url, owner));

      expect(owner.reconciled).toEqual([[{ id: 'sync-p1', payload: { projectId: 'p1' } }]]);
      // Discarded, not re-run: the id is free for a fresh run.
      await new Promise((r) => setTimeout(r, 500));
      expect(owner.processed).toEqual([]);
      await queue.enqueue('sync-p1', { projectId: 'p1' });
      await eventually(() => expect(owner.processed).toHaveLength(1));
    });

    it('calls reconcile with an empty list after a clean start', async () => {
      const owner = new RecordingOwner('repository-sync');
      ({ app } = await startApp(redisService.url, owner));

      expect(owner.reconciled).toEqual([[]]);
    });
  });

  describe('graceful shutdown', () => {
    it('signals running jobs, reports them as shut down and closes every Redis connection', async () => {
      const owner = new RecordingOwner('repository-sync');
      owner.behaviour = () => new Promise(() => {}); // ignores the signal
      let queue: JobQueue<Payload>;
      ({ app, queue } = await startApp(redisService.url, owner));
      await queue.enqueue('sync-p1', { projectId: 'p1' });
      await eventually(() => expect(owner.processed).toHaveLength(1));

      const started = Date.now();
      await app!.close();
      app = undefined;

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(owner.processed[0]!.signal.reason).toMatchObject({ reason: 'shutdown' });
      expect(owner.failures.map((entry) => entry.failure)).toEqual([{ reason: 'shutdown' }]);
      // Only the test's own connection is left.
      await eventually(async () => {
        const clients = (await redis.client('LIST')) as string;
        expect(clients.trim().split('\n')).toHaveLength(1);
      });
    });
  });

  describe('Redis unavailable', () => {
    it('fails enqueue and cancel with QueueUnavailableError once Redis has gone away', async () => {
      const doomed = await startRedis();
      const owner = new RecordingOwner('repository-sync');
      let queue: JobQueue<Payload>;
      try {
        ({ app, queue } = await startApp(doomed.url, owner));
      } finally {
        await doomed.stop();
      }

      await expect(queue.enqueue('sync-p1', { projectId: 'p1' })).rejects.toThrow(
        QueueUnavailableError,
      );
      await expect(queue.cancel('sync-p1')).rejects.toThrow(QueueUnavailableError);
    });

    it('refuses to start (instead of hanging) when Redis is unreachable and queues are registered', async () => {
      const owner = new RecordingOwner('repository-sync');

      await expect(startApp('redis://127.0.0.1:1', owner)).rejects.toThrow(QueueUnavailableError);
    });
  });
});
