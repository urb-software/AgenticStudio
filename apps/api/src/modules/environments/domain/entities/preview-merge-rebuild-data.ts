/** What a Project's waiting rebuild after a merge is restored from. */
export interface PreviewMergeRebuildData {
  /** The Project it belongs to: at most one per Project. */
  readonly projectId: string;
  readonly runId: string;
  readonly mergedCommit: string;
  readonly mergedAt: Date;
  /** When the Clone fetch that should bring the merge in was started. */
  readonly fetchStartedAt: Date;
  readonly recordedAt: Date;
  /** Set together with `failedAt`: why the rebuild was given up or refused. */
  readonly failure: string | null;
  readonly failedAt: Date | null;
}
