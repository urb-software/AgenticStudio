import type { WorkerStatusReport } from '@agentic-studio/contracts';
import type { Provider } from '../entities/run.js';

/**
 * What an agent worker last reported about itself (Issue #101), as a plain record: its runner
 * mode and the Providers its own configuration enables (the shared protocol's report), with who
 * sent it and when. Studio keeps it in memory only.
 */
export interface RecordedWorkerStatus extends WorkerStatusReport {
  workerId: string;
  reportedAt: Date;
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
}
