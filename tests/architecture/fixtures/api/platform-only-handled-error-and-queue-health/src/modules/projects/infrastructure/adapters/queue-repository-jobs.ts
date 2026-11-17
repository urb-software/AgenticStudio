import { JobQueues } from '../../../../platform/queue/job-queue.js';

export class QueueRepositoryJobs {
  constructor(private readonly queues: JobQueues) {}

  start(): void {
    this.queues.register('repository-git');
  }
}
