import { Queue } from '@agentic-studio/queue';

export type StartExecutionInput = string;

export class StartExecutionHandler {
  private readonly queue = new Queue('executions');

  async execute(executionId: StartExecutionInput): Promise<void> {
    await this.queue.add('start', { executionId });
  }
}
