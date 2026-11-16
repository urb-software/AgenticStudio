/** DI token of the {@link RetentionPolicy} setting. */
export const RETENTION_POLICY = Symbol('RETENTION_POLICY');

/**
 * How long a finished Run's Working copy is kept (Issue #143): the periods and limits of the
 * `STUDIO_RETENTION_*` settings. Studio decides; the agent worker removes what Studio says.
 */
export interface RetentionPolicy {
  /** A finished Run without a pull request keeps its Working copy this many days. */
  days: number;
  /** ...and at most this many such Runs per Project keep it. */
  maxPerProject: number;
  /** A Run with a pull request keeps it until this many days without activity... */
  openPullRequestIdleDays: number;
  /** ...or this many hours after the pull request was merged or closed, whichever is first. */
  hoursAfterPullRequestEnd: number;
}
