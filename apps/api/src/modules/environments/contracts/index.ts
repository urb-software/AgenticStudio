export const MERGED_RUN_PREVIEWS = Symbol('MERGED_RUN_PREVIEWS');

/**
 * The Preview's state for a merged Run's commit: `not_configured`, `not_started` (a merge never
 * starts a stopped Preview), `waiting` for the Clone or a build, `building`, `running`, `failed`,
 * or `replaced` by a newer build or merge.
 */
export type PreviewOfMergeState =
  'not_configured' | 'not_started' | 'waiting' | 'building' | 'running' | 'failed' | 'replaced';

export interface PreviewOfMerge {
  state: PreviewOfMergeState;
}

/** A merge through Studio, as far as the Preview needs it. */
export interface MergedRun {
  projectId: string;
  runId: string;
  mergedCommit: string;
  mergedAt: Date;
  /** When the Clone fetch that should bring the merge in was started. */
  fetchStartedAt: Date;
}

/**
 * What `executions` tells the Preview of a merge, and asks of it, through the public face of
 * `environments`.
 */
export interface MergedRunPreviews {
  /**
   * Asks the Project's Preview to rebuild once its Clone holds the merge, when it runs or
   * builds. Never throws: a merge is never delayed, failed or undone by the Preview.
   */
  merged(merge: MergedRun): Promise<void>;

  /** The Preview's state for the commit the Run's merge made. */
  forMerge(projectId: string, runId: string, mergedCommit: string): Promise<PreviewOfMerge>;
}
