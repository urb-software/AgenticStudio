import { Queue } from 'bullmq';

export class StartExecutionHandler {
  constructor(private readonly queue: Queue) {}

  async execute(executionId: string): Promise<void> {
    await this.queue.add('execute', { executionId });
  }
}
