import type { RecordedWorkerStatus } from '../../domain/services/provider-availability.js';
import type { WorkerStatusStore } from '../../ports/worker-status-store.js';

/** The single API process keeps the latest worker status in memory (Issue #101). */
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
