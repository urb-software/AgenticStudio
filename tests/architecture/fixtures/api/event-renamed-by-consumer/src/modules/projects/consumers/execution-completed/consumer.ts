import type { ExecutionCompletedV1 } from '../../../executions/contracts/index.js';

export type { ExecutionCompletedV1 as Done } from '../../../executions/contracts/index.js';

export class ExecutionCompletedConsumer {
  handle(event: ExecutionCompletedV1): string {
    return event.executionId;
  }
}
