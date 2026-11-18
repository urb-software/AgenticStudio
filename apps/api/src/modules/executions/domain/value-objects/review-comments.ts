/**
 * Untrusted text: anyone can comment on a public pull request, so nothing reaches an agent unless
 * the operator selects it.
 */

export const REVIEW_COMMENT_SCOPES = ['since_last_result', 'unresolved'] as const;
export type ReviewCommentScope = (typeof REVIEW_COMMENT_SCOPES)[number];

export const REVIEW_COMMENT_KINDS = ['review', 'inline', 'conversation'] as const;
export type ReviewCommentKind = (typeof REVIEW_COMMENT_KINDS)[number];

export const REVIEW_VERDICTS = ['commented', 'changes_requested', 'approved'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_COMMENTS_MAX = 100;

export const REVIEW_COMMENT_TEXT_MAX_BYTES = 8 * 1024;

export const REVIEW_COMMENT_DIFF_CONTEXT_MAX_BYTES = 2 * 1024;

export const FOLLOW_UP_AUTHORS_MAX = 20;

export interface ReviewComment {
  /** Unique within the pull request: `review-<n>`, `inline-<n>` or `conversation-<n>`. */
  id: string;
  author: string;
  kind: ReviewCommentKind;
  path?: string;
  line?: number;
  diffContext?: string;
  verdict?: ReviewVerdict;
  text: string;
  textCut?: true;
  createdAt: string;
}

export interface ReviewCommentsRequest {
  scope: ReviewCommentScope;
  since: Date | null;
}
