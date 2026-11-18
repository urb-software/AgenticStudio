import type { LogRedaction } from '../value-objects/log-redaction.js';
import type { ReviewCommentInput } from '../value-objects/review-comment.js';
import type { ReviewCommentScope } from '../value-objects/review-comment-scope.js';

/** What a pull request's comments are loaded from: the Git host's answer. */
export interface ReviewCommentsAnswerFacts {
  scope: ReviewCommentScope;
  comments: readonly ReviewCommentInput[];
  /** The Git host already left some out. */
  truncated: boolean;
  redaction: LogRedaction;
  loadedAt: Date;
}
