import type { ExecutionSummaryV1 } from '../../../executions/contracts/index.js';

export class ArchiveProjectHandler {
  canArchive(running: ExecutionSummaryV1[]): boolean {
    return running.length === 0;
  }
}
