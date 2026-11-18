import { Inject, Injectable } from '@nestjs/common';
import {
  type ProviderAvailability,
  WorkerStatus,
} from '../../../domain/value-objects/worker-status.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

export type ListProvidersResult = ProviderAvailability[];

@Injectable()
export class ListProvidersHandler {
  constructor(
    @Inject(WORKER_STATUS_STORE) private readonly statuses: WorkerStatusStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
  ) {}

  async execute(): Promise<ListProvidersResult> {
    return WorkerStatus.providerAvailability(
      this.statuses.latest(),
      this.clock.now(),
      this.lease.seconds,
    );
  }
}
