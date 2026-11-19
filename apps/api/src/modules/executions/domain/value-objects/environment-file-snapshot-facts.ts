export interface EnvironmentFileSnapshotFacts {
  isFinal: boolean;
  /** A failed delivery that can be retried, or a Run stopped at the usage limit. */
  keepsForRetry: boolean;
  deliveryRequested: boolean;
  finishedAt: Date | null;
}
