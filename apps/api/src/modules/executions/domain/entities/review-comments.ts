/**
 * Review comments (Issue #146): what people wrote on the Run's pull request, loaded on the
 * operator's request through an agent worker and the Agent account. They are untrusted text:
 * anyone can comment on a public pull request, so nothing here reaches an agent unless the
 * operator selects it. The worker protocol's lists are pinned to these by a test.
 */

/** What a load asks for: the comments created since the latest result, or all unresolved ones. */
export const REVIEW_COMMENT_SCOPES = ['since_last_result', 'unresolved'] as const;
export type ReviewCommentScope = (typeof REVIEW_COMMENT_SCOPES)[number];

/** A review's summary, an inline comment on the diff, or a conversation comment. */
export const REVIEW_COMMENT_KINDS = ['review', 'inline', 'conversation'] as const;
export type ReviewCommentKind = (typeof REVIEW_COMMENT_KINDS)[number];

export const REVIEW_VERDICTS = ['commented', 'changes_requested', 'approved'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** Most comments a loaded set holds. */
export const REVIEW_COMMENTS_MAX = 100;

/** Longest text of one comment, in UTF-8 bytes. */
export const REVIEW_COMMENT_TEXT_MAX_BYTES = 8 * 1024;

/** Longest diff context of one inline comment, in UTF-8 bytes. */
export const REVIEW_COMMENT_DIFF_CONTEXT_MAX_BYTES = 2 * 1024;

/** Most distinct authors a Follow-up records. */
export const FOLLOW_UP_AUTHORS_MAX = 20;

/** One comment as Studio keeps it: redacted and within its limits. */
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
  /** The text was cut to its size limit. */
  textCut?: true;
  createdAt: string;
}

/** The comments of the Run's latest load (at most one set per Run). */
export interface ReviewCommentSet {
  scope: ReviewCommentScope;
  comments: ReviewComment[];
  /** More comments existed than are kept, or a text was cut. */
  truncated: boolean;
  loadedAt: Date;
}

/** What the Run page needs to know of a load: under way (also while it waits), or why it failed. */
export interface ReviewCommentLoadState {
  loading: boolean;
  /** The worker's words for the latest load when it failed (redacted); null otherwise. */
  error: string | null;
}

/** The Run's loaded Review comments with the state of the load. */
export interface ReviewComments {
  set: ReviewCommentSet | null;
  load: ReviewCommentLoadState;
}

/** What a load asks of the worker: the scope and, for the first, when a comment counts as new. */
export interface ReviewCommentsRequest {
  scope: ReviewCommentScope;
  since: Date | null;
}
