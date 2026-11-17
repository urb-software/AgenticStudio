import { PROVIDER_NAMES, type WorkerStatusReport } from '@agentic-studio/contracts';
import { PROVIDERS, type Provider } from './provider.js';

/**
 * What an agent worker last reported about itself (Issue #101), as a plain record: its runner
 * mode and the Providers its own configuration enables (the shared protocol's report), with who
 * sent it and when. Studio keeps it in memory only.
 */
export interface RecordedWorkerStatus extends WorkerStatusReport {
  workerId: string;
  reportedAt: Date;
}

/** Why a provider is unavailable; shown to the operator as is. */
export const PROVIDER_UNAVAILABLE_REASONS = {
  switchedOff: 'Switched off on the agent worker',
  noWorker: 'No agent worker is connected',
} as const;
/**
 * Studio's own reasons, or the reason the worker reported for a switched-on provider it cannot
 * run (Issue #105: e.g. an unsupported CLI version).
 */
export type ProviderUnavailableReason = string;

export interface ProviderAvailability {
  id: Provider;
  name: string;
  available: boolean;
  /** Set exactly when unavailable. */
  reason?: ProviderUnavailableReason;
}

/** A Run cannot start: Studio knows its provider is unavailable. */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: Provider,
    readonly reason: ProviderUnavailableReason,
  ) {
    super(reason);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * The agent worker's reported status (Issue #101) as an object that answers what it knows: whether
 * the worker is connected within the lease, and whether it offers a Provider. Studio takes the
 * answer from the report alone; the worker's own check stays authoritative. The time and the lease
 * are passed in.
 */
export class WorkerStatus {
  private constructor(private readonly recorded: RecordedWorkerStatus) {}

  static restore(recorded: RecordedWorkerStatus): WorkerStatus {
    return new WorkerStatus(recorded);
  }

  get workerId(): string {
    return this.recorded.workerId;
  }

  get reportedAt(): Date {
    return this.recorded.reportedAt;
  }

  /** Whether the report is not older than the lease: the worker counts as connected. */
  isConnected(now: Date, leaseSeconds: number): boolean {
    return WorkerStatus.isWithinLease(this.recorded.reportedAt, now, leaseSeconds);
  }

  /** The worker's reason for a switched-on Provider it cannot run, if it gave one. */
  reasonFor(provider: Provider): string | undefined {
    return this.recorded.providerReasons?.[provider];
  }

  /** Whether the Provider is switched on in the worker's configuration. */
  hasSwitchedOn(provider: Provider): boolean {
    return this.recorded.providers[provider] === true;
  }

  /** Whether something last seen at `seenAt` (a worker's report) is still within the lease. */
  static isWithinLease(seenAt: Date | undefined, now: Date, leaseSeconds: number): boolean {
    return seenAt !== undefined && now.getTime() - seenAt.getTime() <= leaseSeconds * 1000;
  }

  /**
   * Whether any agent worker has reported within the lease (Issue #142): lookups need no Working
   * copy, so any connected worker can carry one out. `latest` is the latest report, if any.
   */
  static isAnyConnected(
    latest: RecordedWorkerStatus | undefined,
    now: Date,
    leaseSeconds: number,
  ): boolean {
    return latest !== undefined && WorkerStatus.restore(latest).isConnected(now, leaseSeconds);
  }

  /**
   * Which providers can take a Run, from the latest worker status (`undefined`: none reported). A
   * status older than the worker lease (`STUDIO_WORKER_LEASE_SECONDS`) counts as no worker
   * connected. A switched-on provider with a reason from the worker (Issue #105) is unavailable
   * with that reason.
   */
  static providerAvailability(
    latest: RecordedWorkerStatus | undefined,
    now: Date,
    leaseSeconds: number,
  ): ProviderAvailability[] {
    const status = latest === undefined ? undefined : WorkerStatus.restore(latest);
    return PROVIDERS.map((id) => {
      const name = PROVIDER_NAMES[id];
      if (status === undefined || !status.isConnected(now, leaseSeconds)) {
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
