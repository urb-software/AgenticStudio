import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

/** What Studio shows of the agent side (Issue #143). */
export interface AgentWorkerView {
  connected: boolean;
  disk?: {
    workingCopiesBytes: number;
    cachesBytes: number;
    keptRuns: number;
    freeBytes: number;
    totalBytes: number;
    minFreeBytes: number;
    /** Free space is below the threshold. */
    low: boolean;
  };
}

/**
 * Query (Issue #143): whether an agent worker is connected (it reported within the lease) and
 * the disk figures of its latest report. A report older than the lease shows no figures: they
 * would be stale.
 */
@Injectable()
export class GetAgentWorkerHandler {
  constructor(
    @Inject(WORKER_STATUS_STORE) private readonly statuses: WorkerStatusStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
  ) {}

  execute(): AgentWorkerView {
    const latest = this.statuses.latest();
    const connected =
      latest !== undefined &&
      this.clock.now().getTime() - latest.reportedAt.getTime() <= this.lease.seconds * 1000;
    if (!connected || latest.disk === undefined) return { connected };
    return {
      connected,
      disk: { ...latest.disk, low: latest.disk.freeBytes < latest.disk.minFreeBytes },
    };
  }
}
