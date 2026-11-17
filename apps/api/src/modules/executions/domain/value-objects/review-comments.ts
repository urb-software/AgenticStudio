/**
 * Review comments (Issue #146): what people wrote on the Run's pull request, loaded on the
 * operator's request through an agent worker and the Agent account. They are untrusted text:
 * anyone can comment on a public pull request, so nothing here reaches an agent unless the
 * operator selects it. The worker protocol's lists are pinned to these by a test.
 */

import type { LogRedaction } from './log-redaction.js';

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

/** Control characters other than the line break and the tab (PostgreSQL's JSON cannot hold NUL). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/**
 * `text` cut to at most `maxBytes` UTF-8 bytes at a character boundary. It mirrors `cutToBytes` of
 * the worker protocol: the domain may not import the contracts package.
 */
function cutToBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  // Back off continuation bytes (10xxxxxx) so no character is split.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), cut: true };
}

/** What a set holds, to restore it from. */
export interface ReviewCommentSetData {
  scope: ReviewCommentScope;
  comments: ReviewComment[];
  /** More comments existed than are kept, or a text was cut. */
  truncated: boolean;
  loadedAt: Date;
}

/** The comments of the Run's latest load (at most one set per Run). */
export class ReviewCommentSet {
  readonly scope: ReviewCommentScope;
  readonly comments: ReviewComment[];
  /** More comments existed than are kept, or a text was cut. */
  readonly truncated: boolean;
  readonly loadedAt: Date;

  private constructor(data: ReviewCommentSetData) {
    this.scope = data.scope;
    this.comments = data.comments;
    this.truncated = data.truncated;
    this.loadedAt = data.loadedAt;
  }

  static restore(data: ReviewCommentSetData): ReviewCommentSet {
    return new ReviewCommentSet(data);
  }

  /**
   * The comments a worker read, as Studio stores them (Issue #146): token-shaped strings and the
   * Run's known secret values redacted (`redaction`), control characters removed, each text and
   * diff context cut to its size in UTF-8 bytes (after the redaction, which can change a text's
   * length), and at most {@link REVIEW_COMMENTS_MAX} kept (the latest). `truncated` says that
   * anything was cut or left out. The text stays plain text: nothing here interprets markup or
   * links.
   */
  static sanitize(
    comments: readonly ReviewComment[],
    alreadyTruncated: boolean,
    redaction: LogRedaction,
  ): { comments: ReviewComment[]; truncated: boolean } {
    let truncated = alreadyTruncated;
    const clean = (text: string) => redaction.text(text).replace(CONTROL, '');
    const kept = comments.slice(-REVIEW_COMMENTS_MAX);
    if (kept.length < comments.length) truncated = true;
    const result = kept.map((comment): ReviewComment => {
      const text = cutToBytes(clean(comment.text), REVIEW_COMMENT_TEXT_MAX_BYTES);
      const context =
        comment.diffContext === undefined
          ? undefined
          : cutToBytes(clean(comment.diffContext), REVIEW_COMMENT_DIFF_CONTEXT_MAX_BYTES);
      // A login that redaction would change is no login: it is not shown half-masked.
      const author = redaction.text(comment.author) === comment.author ? comment.author : 'unknown';
      const textCut = text.cut || comment.textCut === true;
      if (textCut || (context?.cut ?? false)) truncated = true;
      return {
        id: comment.id,
        author,
        kind: comment.kind,
        ...(comment.path === undefined
          ? {}
          : { path: clean(comment.path).slice(0, 500) || 'file' }),
        ...(comment.line === undefined ? {} : { line: comment.line }),
        ...(context === undefined ? {} : { diffContext: context.text }),
        ...(comment.verdict === undefined ? {} : { verdict: comment.verdict }),
        text: text.text,
        ...(textCut ? { textCut: true as const } : {}),
        createdAt: comment.createdAt,
      };
    });
    return { comments: result, truncated };
  }

  /** The comments by the ids the operator selected, in the set's order; `null` if any is unknown. */
  select(ids: readonly string[]): ReviewComment[] | null {
    const wanted = new Set(ids);
    if (wanted.size !== ids.length) return null;
    const selected = this.comments.filter((comment) => wanted.has(comment.id));
    return selected.length === wanted.size ? selected : null;
  }

  /** The distinct authors of the comments, in order of appearance, at most the Follow-up's cap. */
  static distinctAuthors(comments: readonly ReviewComment[]): string[] {
    return [...new Set(comments.map((comment) => comment.author))].slice(0, FOLLOW_UP_AUTHORS_MAX);
  }
}

/** What the Run page needs to know of a load: under way (also while it waits), or why it failed. */
export interface ReviewCommentLoadState {
  loading: boolean;
  /** The worker's words for the latest load when it failed (redacted); null otherwise. */
  error: string | null;
}

/** The Run's loaded Review comments with the state of the load. */
export class ReviewComments {
  readonly set: ReviewCommentSet | null;
  readonly load: ReviewCommentLoadState;

  private constructor(set: ReviewCommentSet | null, load: ReviewCommentLoadState) {
    this.set = set;
    this.load = load;
  }

  static restore(data: {
    set: ReviewCommentSet | null;
    load: ReviewCommentLoadState;
  }): ReviewComments {
    return new ReviewComments(data.set, data.load);
  }

  /** Whether a comment was written by the operator's own account (exact, case-insensitive). */
  static isByOperator(author: string, operatorLogin: string | null): boolean {
    return operatorLogin !== null && author.toLowerCase() === operatorLogin.toLowerCase();
  }

  /** The Run's loaded comments as the page is shown them, each marked as the operator's or not. */
  view(operatorLogin: string | null): ReviewCommentsView {
    return {
      operatorLogin,
      comments: (this.set?.comments ?? []).map((comment) => ({
        ...comment,
        byOperator: ReviewComments.isByOperator(comment.author, operatorLogin),
      })),
      truncated: this.set?.truncated ?? false,
      scope: this.set?.scope ?? null,
      loadedAt: this.set?.loadedAt ?? null,
      loading: this.load.loading,
      error: this.load.error,
    };
  }
}

/** One comment with whether the operator's own account wrote it (Issue #146). */
export type ReviewCommentWithOperator = ReviewComment & { byOperator: boolean };

/**
 * What the Run page is shown (Issue #146): the loaded comments (each marked as the operator's or
 * not), the configured login, and the state of the latest load. Built by the handlers, so the HTTP
 * contract maps a plain shape and needs no domain code.
 */
export interface ReviewCommentsView {
  operatorLogin: string | null;
  comments: ReviewCommentWithOperator[];
  truncated: boolean;
  scope: ReviewCommentScope | null;
  loadedAt: Date | null;
  loading: boolean;
  error: string | null;
}

/**
 * The comments chosen for a Follow-up are not all in the Run's loaded set (loaded again meanwhile,
 * sent already, or never loaded): the operator loads them again.
 */
export class ReviewCommentsNotLoadedError extends Error {
  constructor() {
    super('Some of the selected review comments are not loaded.');
    this.name = 'ReviewCommentsNotLoadedError';
  }
}

/** A load of Review comments is under way already (Issue #146). */
export class ReviewCommentsLoadRunningError extends Error {
  constructor() {
    super('A load of the review comments is already running.');
    this.name = 'ReviewCommentsLoadRunningError';
  }
}

/** What a load asks of the worker: the scope and, for the first, when a comment counts as new. */
export interface ReviewCommentsRequest {
  scope: ReviewCommentScope;
  since: Date | null;
}
