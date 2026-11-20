import type { ExecutionSummary } from '../../executions/contracts/index.js';

export interface ProjectExecutions {
  latest(projectId: string): Promise<ExecutionSummary | null>;
}
