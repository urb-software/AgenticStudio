import type { WorkerStatusReport } from '@agentic-studio/contracts';

/** Studio keeps it in memory only. */
export interface RecordedWorkerStatus extends WorkerStatusReport {
  workerId: string;
  reportedAt: Date;
}
