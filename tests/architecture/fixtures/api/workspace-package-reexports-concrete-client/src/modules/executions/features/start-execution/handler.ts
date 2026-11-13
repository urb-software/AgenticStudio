import { Queue } from '@agentic-studio/queue';

export class StartExecutionHandler {
  private readonly queue = new Queue('executions');

  async execute(executionId: string): Promise<void> {
    await this.queue.add('start', { executionId });
  }
}
