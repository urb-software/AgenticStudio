import type { ReviewComment, ReviewCommentScope } from './review-comments.js';

/** What a Run's loaded Review comments hold, to restore them from. */
export interface ReviewCommentsSnapshot {
  readonly scope: ReviewCommentScope;
  readonly comments: readonly ReviewComment[];
  /** More comments existed than are kept, or a text was cut. */
  readonly truncated: boolean;
  readonly loadedAt: Date;
}
