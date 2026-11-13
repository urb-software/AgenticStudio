import { RecordExecutionHandler } from '../../features/record-execution/handler.js';

// A competing local definition instead of the publisher's public contract.
interface ExecutionCompletedV1 {
  executionId: string;
  projectId: string;
}

export class ExecutionCompletedConsumer {
  constructor(private readonly handler: RecordExecutionHandler) {}

  async handle(event: ExecutionCompletedV1): Promise<void> {
    await this.handler.execute(event.projectId, event.executionId);
  }
}
