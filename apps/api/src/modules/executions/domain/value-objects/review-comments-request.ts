import type { ReviewCommentScope } from './review-comment-scope.js';

export interface ReviewCommentsRequest {
  scope: ReviewCommentScope;
  since: Date | null;
}
