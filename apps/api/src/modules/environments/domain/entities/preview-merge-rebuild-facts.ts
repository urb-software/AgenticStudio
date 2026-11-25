/** What recording a merge's rebuild is made from. */
export interface PreviewMergeRebuildFacts {
  projectId: string;
  runId: string;
  mergedCommit: string;
  mergedAt: Date;
  fetchStartedAt: Date;
  now: Date;
}
