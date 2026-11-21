import type { MergeReviewState } from './merge-review-state.js';

/** What Studio knows about a Run before it asks the Git host anything. */
export interface MergeStudioFacts {
  /** The commit the operator reviewed and names in the request. */
  commit: string;
  runActive: boolean;
  hasPullRequest: boolean;
  /** The merge review's state now (`none` when no review was requested) and its commit. */
  review: { state: MergeReviewState; runCommit: string | null };
}
