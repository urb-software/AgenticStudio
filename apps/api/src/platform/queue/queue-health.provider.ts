import type { Provider } from '@nestjs/common';
import { BullMqJobQueues } from './bullmq-job-queues.js';
import { JobQueues } from './job-queue.js';
import { QueueHealth } from './queue-health.js';

/**
 * Platform-internal: provides {@link QueueHealth} to the health module from the global
 * JobQueues instance, without exporting it app-wide. Not part of the queue module's public
 * surface; business modules cannot reach this file or `queue-health.ts`
 * (architecture:api `api-queue-health-platform-only`).
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
