import type { ReviewComments } from '../value-objects/review-comments.js';

/** DI token for the {@link ReviewCommentRepository} adapter. */
export const REVIEW_COMMENT_REPOSITORY = Symbol('REVIEW_COMMENT_REPOSITORY');

/**
 * The store of the Run's loaded Review comments (Issue #146): at most one set per Run, stored by
 * the lookup that read it ({@link RunLookupRepository.completeReviewComments}), replaced by each
 * load and removed when a Follow-up prepared from it is sent. Nothing here sends anything.
 */
export interface ReviewCommentRepository {
  /**
   * The Run's loaded set (or none) and the state of its latest load: under way when a
   * `review_comments` lookup of the Run is open (waiting, being answered, or waiting out a rate
   * limit), otherwise the latest failed lookup's error. An unknown Run has neither.
   */
  findReviewComments(runId: string): Promise<ReviewComments>;
}
