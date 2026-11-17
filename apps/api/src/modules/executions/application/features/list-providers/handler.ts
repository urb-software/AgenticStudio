import { Inject, Injectable } from '@nestjs/common';
import {
  type ProviderAvailability,
  providerAvailability,
} from '../../../domain/services/provider-availability.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

/** Query (Issue #101): every provider and whether a Run can be started with it now. */
@Injectable()
export class ListProvidersHandler {
  constructor(
    @Inject(WORKER_STATUS_STORE) private readonly statuses: WorkerStatusStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
  ) {}

  execute(): ProviderAvailability[] {
    return providerAvailability(this.statuses.latest(), this.clock.now(), this.lease.seconds);
  }
}
