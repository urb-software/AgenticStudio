import type { EnvironmentFileSnapshotFacts } from './environment-file-snapshot-facts.js';

/**
 * When a Run no longer needs the snapshot of its Environment file. The store's release query
 * follows `releasable`, which a test proves.
 */
export class EnvironmentFileSnapshotRule {
  private constructor(readonly retryableFinishedBefore: Date) {}

  static at(now: Date, retentionDays: number): EnvironmentFileSnapshotRule {
    return new EnvironmentFileSnapshotRule(
      new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000),
    );
  }

  static finishedBefore(cutoff: Date): EnvironmentFileSnapshotRule {
    return new EnvironmentFileSnapshotRule(cutoff);
  }

  /** A retryable Run keeps its snapshot while a retry is requested or the retention period lasts. */
  releasable(facts: EnvironmentFileSnapshotFacts): boolean {
    if (!facts.isFinal) return false;
    if (!facts.keepsForRetry) return true;
    return !(
      facts.deliveryRequested ||
      (facts.finishedAt !== null && facts.finishedAt >= this.retryableFinishedBefore)
    );
  }

  /** Right after a state report the retention period has just begun, so a retryable Run keeps it. */
  static releasesAfterReport(facts: EnvironmentFileSnapshotFacts): boolean {
    return facts.environmentFileSupplied && facts.isFinal && !facts.keepsForRetry;
  }
}
