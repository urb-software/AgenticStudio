import { PROVIDER_NAMES } from '@agentic-studio/contracts';
import { PROVIDERS } from './provider.js';
import type { Lease } from './lease.js';
import type { WorkerStatusData } from './worker-status-data.js';
import type { ProviderAvailability } from './provider-availability.js';
import { PROVIDER_UNAVAILABLE_REASONS } from './provider-unavailable-reason.js';
import { WorkerStatus } from './worker-status.js';

/** What the latest worker report says about the agent workers, judged against the lease. */
export class WorkerPresence {
  private constructor(
    private readonly latest: WorkerStatus | undefined,
    private readonly lease: Lease,
  ) {}

  static of(latest: WorkerStatusData | undefined, lease: Lease): WorkerPresence {
    return new WorkerPresence(
      latest === undefined ? undefined : WorkerStatus.restore(latest),
      lease,
    );
  }

  /** Lookups need no Working copy, so any connected worker can carry one out. */
  isAnyConnected(now: Date): boolean {
    return this.latest !== undefined && this.latest.isConnected(now, this.lease.seconds);
  }

  /**
   * A status older than the worker lease counts as no worker connected; a switched-on provider with
   * a reason from the worker is unavailable with that reason.
   */
  providerAvailability(now: Date): ProviderAvailability[] {
    const status = this.latest;
    return PROVIDERS.map((id) => {
      const name = PROVIDER_NAMES[id];
      if (status === undefined || !status.isConnected(now, this.lease.seconds)) {
        return { id, name, available: false, reason: PROVIDER_UNAVAILABLE_REASONS.noWorker };
      }
      if (!status.hasSwitchedOn(id)) {
        return { id, name, available: false, reason: PROVIDER_UNAVAILABLE_REASONS.switchedOff };
      }
      const workerReason = status.reasonFor(id);
      if (workerReason !== undefined) return { id, name, available: false, reason: workerReason };
      return { id, name, available: true };
    });
  }
}
