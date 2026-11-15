import type { WorkerStatus } from '../../domain/services/provider-availability.js';
import type { WorkerStatusStore } from '../../ports/worker-status-store.js';

/** The single API process keeps the latest worker status in memory (Issue #101). */
export class InMemoryWorkerStatusStore implements WorkerStatusStore {
  private current: WorkerStatus | undefined;

  record(status: WorkerStatus): void {
    this.current = status;
  }

  latest(): WorkerStatus | undefined {
    return this.current;
  }
}
