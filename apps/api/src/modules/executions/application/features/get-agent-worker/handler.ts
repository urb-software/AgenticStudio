import type { WorkerDisk } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { anyWorkerConnected } from '../../../domain/services/follow-up-context.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

/** What Studio shows of the agent side (Issue #143). */
export interface AgentWorkerView {
  connected: boolean;
  /** The worker's disk figures, with whether free space is below its threshold. */
  disk?: WorkerDisk & { low: boolean };
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
    const connected = anyWorkerConnected(this.statuses, this.clock.now(), this.lease.seconds);
    if (!connected || latest?.disk === undefined) return { connected };
    return {
      connected,
      disk: { ...latest.disk, low: latest.disk.freeBytes < latest.disk.minFreeBytes },
    };
  }
}
