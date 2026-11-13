import { Global, Module } from '@nestjs/common';
import { BullMqJobQueues } from './bullmq-job-queues.js';
import { JobQueues } from './job-queue.js';
import { QueueHealth } from './queue-health.js';

/**
 * Background jobs hosted in the API process (BullMQ on Redis). Business modules inject
 * the {@link JobQueues} port; the BullMQ implementation is not exported.
 */
@Global()
@Module({
  providers: [
    BullMqJobQueues,
    { provide: JobQueues, useExisting: BullMqJobQueues },
    { provide: QueueHealth, useExisting: BullMqJobQueues },
  ],
  exports: [JobQueues, QueueHealth],
})
export class QueueModule {}
