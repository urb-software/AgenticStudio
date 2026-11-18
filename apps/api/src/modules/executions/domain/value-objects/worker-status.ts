import { PROVIDER_NAMES, type WorkerStatusReport } from '@agentic-studio/contracts';
import { PROVIDERS, type Provider } from './provider.js';

/** Studio keeps it in memory only. */
export interface RecordedWorkerStatus extends WorkerStatusReport {
  workerId: string;
  reportedAt: Date;
}

/** Shown to the operator as is. */
export const PROVIDER_UNAVAILABLE_REASONS = {
  switchedOff: 'Switched off on the agent worker',
  noWorker: 'No agent worker is connected',
} as const;
export type ProviderUnavailableReason = string;

export interface ProviderAvailability {
  id: Provider;
  name: string;
  available: boolean;
  reason?: ProviderUnavailableReason;
}

/** Studio takes the answer from the report alone; the worker's own check stays authoritative. */
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

  isConnected(now: Date, leaseSeconds: number): boolean {
    return WorkerStatus.isWithinLease(this.recorded.reportedAt, now, leaseSeconds);
  }

  reasonFor(provider: Provider): string | undefined {
    return this.recorded.providerReasons?.[provider];
  }

  hasSwitchedOn(provider: Provider): boolean {
    return this.recorded.providers[provider] === true;
  }

  static isWithinLease(seenAt: Date | undefined, now: Date, leaseSeconds: number): boolean {
    return seenAt !== undefined && now.getTime() - seenAt.getTime() <= leaseSeconds * 1000;
  }

  /** Lookups need no Working copy, so any connected worker can carry one out. */
  static isAnyConnected(
    latest: RecordedWorkerStatus | undefined,
    now: Date,
    leaseSeconds: number,
  ): boolean {
    return latest !== undefined && WorkerStatus.restore(latest).isConnected(now, leaseSeconds);
  }

  /**
   * A status older than the worker lease counts as no worker connected; a switched-on provider with a reason from the
   * worker is unavailable with that reason.
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
