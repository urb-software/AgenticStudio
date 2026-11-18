import type { ReviewComments } from '../entities/review-comments.js';
import type { ReviewCommentsSnapshot } from '../entities/review-comments-snapshot.js';

/** DI token for the {@link ReviewCommentRepository} adapter. */
export const REVIEW_COMMENT_REPOSITORY = Symbol('REVIEW_COMMENT_REPOSITORY');

/**
 * The store of the Run's loaded Review comments (Issue #146): at most one set per Run, stored by
 * the answer of the lookup that read it, replaced by each load and removed when a Follow-up
 * prepared from it is sent. Nothing here sends anything. The state of the latest load is the
 * lookups', not kept here.
 */
export interface ReviewCommentRepository {
  /** The Run's loaded set as the aggregate, or `null` when there is none. */
  find(runId: string): Promise<ReviewComments | null>;

  /** The Run's loaded set as plain data, or `null` when there is none. */
  findSnapshot(runId: string): Promise<ReviewCommentsSnapshot | null>;

  /** Stores the Run's loaded set, replacing an earlier one (one per Run). */
  replace(runId: string, comments: ReviewComments): Promise<void>;

  /** Removes the Run's loaded set (a Follow-up prepared from it was sent); a missing one is fine. */
  discard(runId: string): Promise<void>;
}
