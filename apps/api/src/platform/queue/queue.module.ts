import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import {
  BullMqJobQueues,
  QUEUE_WORKER_TUNING,
  type QueueWorkerTuning,
} from './bullmq-job-queues.js';
import { JobQueues } from './job-queue.js';
import { QueueHealth } from './queue-health.js';

export type { QueueWorkerTuning };

/**
 * Background jobs hosted in the API process (BullMQ on Redis). Global, but it exports only
 * the {@link JobQueues} port: the BullMQ implementation and {@link QueueHealth} are not
 * injectable from business modules.
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

/**
 * Provides {@link QueueHealth} to a platform module (the health endpoint) from the global
 * JobQueues instance, without exporting it app-wide.
 */
export const queueHealthProvider: Provider = {
  provide: QueueHealth,
  inject: [JobQueues],
  useFactory: (queues: JobQueues): QueueHealth => {
    if (!(queues instanceof BullMqJobQueues)) {
      throw new Error('QueueHealth needs the BullMQ job queues.');
    }
    return queues;
  },
};
