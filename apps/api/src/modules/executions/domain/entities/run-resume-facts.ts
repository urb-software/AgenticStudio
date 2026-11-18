/** Read under the lock that serializes claims, so they cannot change before the change is saved. */
export interface ResumeFacts {
  /**
   * Another Run of the Run's Project holds a place: active, held for a retry, or queued to resume.
   */
  projectPlaceTaken: boolean;
  /** How many other Runs hold a place across the server. */
  serverPlacesTaken: number;
  /** The Run's Environment file snapshot (its secret) still exists. */
  environmentFileSnapshotKept: boolean;
}
