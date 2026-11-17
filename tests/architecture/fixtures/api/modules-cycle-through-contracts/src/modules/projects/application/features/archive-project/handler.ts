import type { ExecutionSummaryV1 } from '../../../../executions/contracts/index.js';

export type ArchiveProjectInput = ExecutionSummaryV1[];
export type ArchiveProjectResult = boolean;

export class ArchiveProjectHandler {
  execute(running: ArchiveProjectInput): ArchiveProjectResult {
    return running.length === 0;
  }
}
