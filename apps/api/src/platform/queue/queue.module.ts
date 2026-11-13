import { Global, Module } from '@nestjs/common';
import { BullMqJobQueues } from './bullmq-job-queues.js';
import { JobQueues } from './job-queue.js';

/**
 * Background jobs hosted in the API process (BullMQ on Redis). Business modules inject
 * the {@link JobQueues} port; the BullMQ implementation stays inside platform/.
 */
@Global()
@Module({
  providers: [BullMqJobQueues, { provide: JobQueues, useExisting: BullMqJobQueues }],
  exports: [JobQueues, BullMqJobQueues],
})
export class QueueModule {}
