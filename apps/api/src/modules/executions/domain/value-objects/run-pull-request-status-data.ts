import type { PullRequestState } from './pull-request-state.js';
import type { RunPullRequestChecks } from './run-pull-request-checks.js';

/**
 * `state` is `null` until the first lookup succeeded, and is kept when a later one fails
 * (`refreshError` then says why). Every field is `null` for a Run without a pull request.
 */
export interface RunPullRequestStatusData {
  state: PullRequestState | null;
  behindBy: number | null;
  aheadBy: number | null;
  mergeable: boolean | null;
  refreshedAt: Date | null;
  refreshError: string | null;
  retryAt: Date | null;
  refreshRequestedAt: Date | null;
  lastAttemptAt: Date | null;
  checks: RunPullRequestChecks | null;
  prepareRequestedAt: Date | null;
  prepareError: string | null;
  /**
   * `null` while it is not over (a reopened one is cleared). Working copy retention counts from it.
   */
  endedAt: Date | null;
  /** Held while one request closes the pull request or deletes the Run branch. */
  closeClaimedAt: Date | null;
  /** Set once Studio closed the pull request with the Merge credential. */
  closedFromStudioAt: Date | null;
  runBranchDeletedAt: Date | null;
  /** Redacted, at most 500 characters; cleared by a successful deletion. */
  runBranchDeletionFailure: string | null;
}
