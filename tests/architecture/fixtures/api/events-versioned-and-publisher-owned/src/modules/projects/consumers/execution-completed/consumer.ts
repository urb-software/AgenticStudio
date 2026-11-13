import { ExecutionCompletedV2Schema } from '../../../executions/contracts/index.js';
import { RecordExecutionHandler } from '../../features/record-execution/handler.js';

export class ExecutionCompletedConsumer {
  constructor(private readonly handler: RecordExecutionHandler) {}

  async handle(message: unknown): Promise<void> {
    const event = ExecutionCompletedV2Schema.parse(message);
    await this.handler.execute(event.projectId, event.executionId);
  }
}
