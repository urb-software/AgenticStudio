import type { WorkerDisk } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { Lease } from '../../../domain/value-objects/lease.js';
import { WorkerPresence } from '../../../domain/value-objects/worker-presence.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

export interface GetAgentWorkerResult {
  connected: boolean;
  disk?: WorkerDisk & { low: boolean };
}

/** A report older than the lease shows no figures: they would be stale. */
@Injectable()
export class GetAgentWorkerHandler {
  constructor(
    @Inject(WORKER_STATUS_STORE) private readonly statuses: WorkerStatusStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
  ) {}

  async execute(): Promise<GetAgentWorkerResult> {
    const latest = this.statuses.latest();
    const connected = WorkerPresence.of(latest, Lease.ofSeconds(this.lease.seconds)).isAnyConnected(
      this.clock.now(),
    );
    if (!connected || latest?.disk === undefined) return { connected };
    return {
      connected,
      disk: { ...latest.disk, low: latest.disk.freeBytes < latest.disk.minFreeBytes },
    };
  }
}
