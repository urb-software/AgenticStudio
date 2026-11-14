import { type DynamicModule, Module } from '@nestjs/common';
import {
  BullMqJobQueues,
  QUEUE_WORKER_TUNING,
  type QueueWorkerTuning,
} from './bullmq-job-queues.js';
import { JobQueues } from './job-queue.js';

export type { QueueWorkerTuning };

/**
 * Background jobs hosted in the API process (BullMQ on Redis). Global, but it exports only
 * the {@link JobQueues} port: the BullMQ implementation and the platform-only `QueueHealth`
 * view (see `queue-health.provider.ts`) are not injectable from business modules.
 */
@Module({})
export class QueueModule {
  static forRoot(tuning: QueueWorkerTuning = {}): DynamicModule {
    return {
      module: QueueModule,
      global: true,
      providers: [
        { provide: QUEUE_WORKER_TUNING, useValue: tuning },
        BullMqJobQueues,
        { provide: JobQueues, useExisting: BullMqJobQueues },
      ],
      exports: [JobQueues],
    };
  }
}
