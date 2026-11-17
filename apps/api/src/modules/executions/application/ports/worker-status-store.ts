import type { RecordedWorkerStatus } from '../../domain/services/provider-availability.js';

/** DI token of the {@link WorkerStatusStore}. */
export const WORKER_STATUS_STORE = Symbol('WORKER_STATUS_STORE');

/**
 * Keeps the latest agent worker status (Issue #101). In memory: a report is refreshed with
 * every poll and is stale after the lease, so nothing is lost by a restart of the API.
 */
export interface WorkerStatusStore {
  /** Replaces the latest status (the most recent report wins, from whichever worker). */
  record(status: RecordedWorkerStatus): void;
  latest(): RecordedWorkerStatus | undefined;
  /** When this worker last reported its status, if it did since the API started (#102). */
  lastSeen(workerId: string): Date | undefined;
}
