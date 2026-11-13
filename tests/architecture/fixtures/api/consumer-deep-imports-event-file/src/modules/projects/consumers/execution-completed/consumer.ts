import type { ExecutionCompletedV1 } from '../../../executions/contracts/events/execution-completed-v1.js';

export class ExecutionCompletedConsumer {
  handle(event: ExecutionCompletedV1): string {
    return event.executionId;
  }
}
