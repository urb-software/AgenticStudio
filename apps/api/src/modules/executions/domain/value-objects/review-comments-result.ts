import type { ReviewCommentInput } from './review-comment.js';

export interface ReviewCommentsResult {
  comments: ReviewCommentInput[];
  truncated: boolean;
}
