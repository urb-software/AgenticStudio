import type { RecordedWorkerStatus } from '../../domain/services/provider-availability.js';
import type { WorkerStatusStore } from '../../ports/worker-status-store.js';

/** The single API process keeps the latest worker status in memory (Issue #101). */
export class InMemoryWorkerStatusStore implements WorkerStatusStore {
  private current: RecordedWorkerStatus | undefined;

  record(status: RecordedWorkerStatus): void {
    this.current = status;
  }

  latest(): RecordedWorkerStatus | undefined {
    return this.current;
  }
}
