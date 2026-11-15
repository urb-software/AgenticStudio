/** DI token of the {@link EnvironmentFileSnapshots} port. */
export const ENVIRONMENT_FILE_SNAPSHOTS = Symbol('ENVIRONMENT_FILE_SNAPSHOTS');

/**
 * The Runs' Environment file snapshots (Issue #104): copied into Run-scoped secrets at claim,
 * used by the Run's log redaction, and deleted once the Run is final, since a final Run stores
 * no more events. Neither method throws: a failure is logged and retried at the next call.
 */
export interface EnvironmentFileSnapshots {
  /** Deletes the snapshot of one Run that is final (after its final state is stored). */
  releaseFor(runId: string): Promise<void>;
  /**
   * Deletes the snapshot of every final Run that still holds one, whichever way it ended, and
   * snapshots no Run references that are older than an hour.
   */
  releaseFinal(): Promise<void>;
}
