import type { RunMergeReview } from '../entities/run-merge-review.js';

export const RUN_MERGE_REVIEW_REPOSITORY = Symbol('RUN_MERGE_REVIEW_REPOSITORY');

/** At most one review per Run, replaced by each new one. */
export interface RunMergeReviewRepository {
  /** `null` when none was requested. */
  find(runId: string): Promise<RunMergeReview | null>;

  /**
   * Stores a new `preparing` review in one statement: it inserts the row, or replaces the Run's
   * review, unless that one is `preparing` and was requested after `staleBefore`. `false` when it
   * is, so two requests never prepare the same Run at once.
   */
  claim(review: RunMergeReview, staleBefore: Date): Promise<boolean>;

  /**
   * Stores the outcome of the review `requestedAt` asked for, only while that review is still the
   * `preparing` one. `false` when a newer request replaced it.
   */
  finish(review: RunMergeReview): Promise<boolean>;
}
