import { Queue } from 'bullmq';

export type StartExecutionInput = string;

export class StartExecutionHandler {
  constructor(private readonly queue: Queue) {}

  async execute(executionId: StartExecutionInput): Promise<void> {
    await this.queue.add('execute', { executionId });
  }
}
