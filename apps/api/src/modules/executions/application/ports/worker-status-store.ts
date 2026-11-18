import type { RecordedWorkerStatus } from '../../domain/value-objects/recorded-worker-status.js';

export const WORKER_STATUS_STORE = Symbol('WORKER_STATUS_STORE');

/** In memory: a report is stale after the lease, so a restart loses nothing. */
export interface WorkerStatusStore {
  record(status: RecordedWorkerStatus): void;
  latest(): RecordedWorkerStatus | undefined;
  /** Only if it reported since the API started. */
  lastSeen(workerId: string): Date | undefined;
}
