import type { RunSweepFacts } from './run-sweep-facts.js';

/**
 * At most once per lease period, so a restart loop cannot keep a dead worker's Run alive. The store
 * renews in one statement.
 */
export class LeaseRenewalRule {
  private constructor(
    readonly now: Date,
    readonly leaseSeconds: number,
  ) {}

  static at(now: Date, leaseSeconds: number): LeaseRenewalRule {
    return new LeaseRenewalRule(now, leaseSeconds);
  }

  renews(run: Pick<RunSweepFacts, 'state'>): boolean {
    return run.state === 'preparing' || run.state === 'running';
  }

  isDue(lastRenewal: Date | null): boolean {
    return (
      lastRenewal === null || this.now.getTime() - lastRenewal.getTime() >= this.leaseSeconds * 1000
    );
  }
}
