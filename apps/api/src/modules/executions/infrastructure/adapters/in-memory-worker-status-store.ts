import type { RecordedWorkerStatus } from '../../domain/value-objects/recorded-worker-status.js';
import type { WorkerStatusStore } from '../../application/ports/worker-status-store.js';

/** Single API process: the latest worker status lives in memory. */
export class InMemoryWorkerStatusStore implements WorkerStatusStore {
  private current: RecordedWorkerStatus | undefined;
  private readonly seen = new Map<string, Date>();

  record(status: RecordedWorkerStatus): void {
    this.current = status;
    this.seen.set(status.workerId, status.reportedAt);
  }

  lastSeen(workerId: string): Date | undefined {
    return this.seen.get(workerId);
  }

  latest(): RecordedWorkerStatus | undefined {
    return this.current;
  }
}
