import type { Provider } from '@nestjs/common';
import { BullMqJobQueues } from './bullmq-job-queues.js';
import { JobQueues } from './job-queue.js';
import { QueueHealth } from './queue-health.js';

/** Provides {@link QueueHealth} to the health module from the global JobQueues instance. */
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
