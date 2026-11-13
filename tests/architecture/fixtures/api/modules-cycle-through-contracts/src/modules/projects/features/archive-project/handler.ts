import type { ExecutionSummary } from '../../../executions/contracts/index.js';

export class ArchiveProjectHandler {
  canArchive(running: ExecutionSummary[]): boolean {
    return running.length === 0;
  }
}
