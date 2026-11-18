import type { ReviewCommentInput } from '../value-objects/review-comment.js';
import type { ReviewCommentScope } from '../value-objects/review-comment-scope.js';

/** What a Run's loaded Review comments hold, to restore them from. */
export interface ReviewCommentsSnapshot {
  readonly scope: ReviewCommentScope;
  readonly comments: readonly ReviewCommentInput[];
  /** More comments existed than are kept, or a text was cut. */
  readonly truncated: boolean;
  readonly loadedAt: Date;
}
