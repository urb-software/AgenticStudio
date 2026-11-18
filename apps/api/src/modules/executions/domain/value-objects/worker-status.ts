import type { Provider } from './provider.js';
import { Lease } from './lease.js';
import type { RecordedWorkerStatus } from './recorded-worker-status.js';

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
    return Lease.ofSeconds(leaseSeconds).covers(this.recorded.reportedAt, now);
  }

  reasonFor(provider: Provider): string | undefined {
    return this.recorded.providerReasons?.[provider];
  }

  hasSwitchedOn(provider: Provider): boolean {
    return this.recorded.providers[provider] === true;
  }
}
