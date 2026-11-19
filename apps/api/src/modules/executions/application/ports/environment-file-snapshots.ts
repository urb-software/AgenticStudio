export const ENVIRONMENT_FILE_SNAPSHOTS = Symbol('ENVIRONMENT_FILE_SNAPSHOTS');

/** Never throws: a failure is logged and retried at the next call. */
export interface EnvironmentFileSnapshots {
  releaseFor(runId: string): Promise<void>;
}

export const RUN_SNAPSHOT_SETTINGS = Symbol('RUN_SNAPSHOT_SETTINGS');

export interface RunSnapshotSettings {
  retentionDays: number;
}
