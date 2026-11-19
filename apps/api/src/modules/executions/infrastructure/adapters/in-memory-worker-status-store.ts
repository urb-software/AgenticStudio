import type { WorkerStatusData } from '../../domain/value-objects/worker-status-data.js';
import type { WorkerStatusStore } from '../../application/ports/worker-status-store.js';

/** Single API process: the latest worker status lives in memory. */
export class InMemoryWorkerStatusStore implements WorkerStatusStore {
  private current: WorkerStatusData | undefined;
  private readonly seen = new Map<string, Date>();

  record(status: WorkerStatusData): void {
    this.current = status;
    this.seen.set(status.workerId, status.reportedAt);
  }

  lastSeen(workerId: string): Date | undefined {
    return this.seen.get(workerId);
  }

  latest(): WorkerStatusData | undefined {
    return this.current;
  }
}
