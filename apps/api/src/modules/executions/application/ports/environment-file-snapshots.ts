export const ENVIRONMENT_FILE_SNAPSHOTS = Symbol('ENVIRONMENT_FILE_SNAPSHOTS');

/** Neither method throws: a failure is logged and retried at the next call. */
export interface EnvironmentFileSnapshots {
  releaseFor(runId: string): Promise<void>;
  /** Also deletes snapshots no Run references that are older than an hour. */
  releaseFinal(): Promise<void>;
}

export const RUN_SNAPSHOT_SETTINGS = Symbol('RUN_SNAPSHOT_SETTINGS');

export interface RunSnapshotSettings {
  retentionDays: number;
}
