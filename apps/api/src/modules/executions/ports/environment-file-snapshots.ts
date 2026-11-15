/** DI token of the {@link EnvironmentFileSnapshots} port. */
export const ENVIRONMENT_FILE_SNAPSHOTS = Symbol('ENVIRONMENT_FILE_SNAPSHOTS');

/**
 * The Runs' Environment file snapshots (Issue #104): copied into Run-scoped secrets at claim,
 * used by the Run's log redaction, and deleted once the Run needs no more redaction: when it is
 * final, except while its failed delivery can be retried (`keepsSnapshotForRetry`); such a
 * snapshot goes when the Run is delivered, when its retry is given up, or after the retention
 * period. Neither method throws: a failure is logged and retried at the next call.
 */
export interface EnvironmentFileSnapshots {
  /** Deletes the snapshot of one Run that no longer needs it (the caller decides when). */
  releaseFor(runId: string): Promise<void>;
  /**
   * Deletes the snapshot of every final Run that no longer needs it, whichever way it ended (a
   * retryable failed delivery past the retention period too), and snapshots no Run references
   * that are older than an hour.
   */
  releaseFinal(): Promise<void>;
}

/** DI token of the {@link RunSnapshotSettings}. */
export const RUN_SNAPSHOT_SETTINGS = Symbol('RUN_SNAPSHOT_SETTINGS');

export interface RunSnapshotSettings {
  /** Days a retryable failed delivery keeps its snapshot (`STUDIO_RUN_SNAPSHOT_RETENTION_DAYS`). */
  retentionDays: number;
}
