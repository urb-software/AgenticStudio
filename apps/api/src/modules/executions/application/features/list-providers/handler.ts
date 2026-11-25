import { PROVIDER_MODELS } from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import { type ProviderAvailability } from '../../../domain/value-objects/provider-availability.js';
import { Lease } from '../../../domain/value-objects/lease.js';
import { WorkerPresence } from '../../../domain/value-objects/worker-presence.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

/** A Provider's availability and the models an agent may name for it (`default` first). */
export type ProviderListing = ProviderAvailability & { models: string[] };
export type ListProvidersResult = ProviderListing[];

@Injectable()
export class ListProvidersHandler {
  constructor(
    @Inject(WORKER_STATUS_STORE) private readonly statuses: WorkerStatusStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
  ) {}

  async execute(): Promise<ListProvidersResult> {
    return WorkerPresence.of(this.statuses.latest(), Lease.ofSeconds(this.lease.seconds))
      .providerAvailability(this.clock.now())
      .map((provider) => ({ ...provider, models: [...PROVIDER_MODELS[provider.id]] }));
  }
}
