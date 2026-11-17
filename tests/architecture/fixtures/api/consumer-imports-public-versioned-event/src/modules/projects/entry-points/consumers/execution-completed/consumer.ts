import type { ExecutionCompletedV1 } from '../../../../executions/contracts/index.js';
import { RecordExecutionHandler } from '../../../application/features/record-execution/handler.js';

export class ExecutionCompletedConsumer {
  constructor(private readonly handler: RecordExecutionHandler) {}

  async handle(event: ExecutionCompletedV1): Promise<void> {
    await this.handler.execute({ projectId: event.projectId, executionId: event.executionId });
  }
}
