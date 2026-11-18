import type { ReviewComments } from '../entities/review-comments.js';
import type { ReviewCommentsSnapshot } from '../entities/review-comments-snapshot.js';

export const REVIEW_COMMENT_REPOSITORY = Symbol('REVIEW_COMMENT_REPOSITORY');

/** At most one set of loaded Review comments per Run. */
export interface ReviewCommentRepository {
  /** `null` when there is none. */
  find(runId: string): Promise<ReviewComments | null>;

  /** `null` when there is none. */
  findSnapshot(runId: string): Promise<ReviewCommentsSnapshot | null>;

  /** Replaces an earlier set. */
  replace(runId: string, comments: ReviewComments): Promise<void>;

  /** A missing one is fine. */
  discard(runId: string): Promise<void>;
}
