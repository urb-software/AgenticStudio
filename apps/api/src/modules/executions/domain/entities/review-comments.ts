import type { FollowUpComments } from '../value-objects/follow-up.js';
import type { LogRedaction } from '../value-objects/log-redaction.js';
import {
  FOLLOW_UP_AUTHORS_MAX,
  REVIEW_COMMENT_DIFF_CONTEXT_MAX_BYTES,
  REVIEW_COMMENT_TEXT_MAX_BYTES,
  REVIEW_COMMENTS_MAX,
  type ReviewComment,
  type ReviewCommentScope,
} from '../value-objects/review-comments.js';

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

/** What a Run's loaded Review comments hold, to restore them from. */
export interface ReviewCommentsSnapshot {
  readonly scope: ReviewCommentScope;
  readonly comments: readonly ReviewComment[];
  /** More comments existed than are kept, or a text was cut. */
  readonly truncated: boolean;
  readonly loadedAt: Date;
}

/**
 * The Review comments of a Run (Issue #146): what people wrote on its pull request, as its latest
 * load left them (at most one set per Run, replaced by each load and removed when a Follow-up
 * prepared from it is sent). An aggregate root of its own: it refers to its Run by id (the key it
 * is stored and found by) and holds nothing of the Run. The Follow-up that sends some of them gets
 * the facts about the selection as values ({@link ReviewComments.selection}).
 */
export class ReviewComments {
  readonly scope: ReviewCommentScope;
  readonly comments: readonly ReviewComment[];
  /** More comments existed than are kept, or a text was cut. */
  readonly truncated: boolean;
  readonly loadedAt: Date;

  private constructor(data: ReviewCommentsSnapshot) {
    this.scope = data.scope;
    this.comments = data.comments;
    this.truncated = data.truncated;
    this.loadedAt = data.loadedAt;
  }

  /** The set a load of the Run's Review comments came to (already sanitized), loaded at `loadedAt`. */
  static load(data: ReviewCommentsSnapshot): ReviewComments {
    return new ReviewComments(data);
  }

  /** A set as storage holds it. */
  static restore(data: ReviewCommentsSnapshot): ReviewComments {
    return new ReviewComments(data);
  }

  /** The current values as read-only plain data. */
  snapshot(): ReviewCommentsSnapshot {
    return {
      scope: this.scope,
      comments: this.comments.map((comment) => ({ ...comment })),
      truncated: this.truncated,
      loadedAt: this.loadedAt,
    };
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

  /**
   * What a Follow-up prepared from the comments with these ids records: how many, and whose (at
   * most the Follow-up's cap of distinct authors, in order of appearance); `null` if any is not in
   * the set. The values the Run's `followUp` takes, so the Run never sees the comments themselves.
   */
  selection(ids: readonly string[]): FollowUpComments | null {
    const selected = this.select(ids);
    if (selected === null) return null;
    return { count: selected.length, authors: ReviewComments.distinctAuthors(selected) };
  }

  /** The distinct authors of the comments, in order of appearance, at most the Follow-up's cap. */
  static distinctAuthors(comments: readonly ReviewComment[]): string[] {
    return [...new Set(comments.map((comment) => comment.author))].slice(0, FOLLOW_UP_AUTHORS_MAX);
  }

  /** Whether a comment was written by the operator's own account (exact, case-insensitive). */
  static isByOperator(author: string, operatorLogin: string | null): boolean {
    return operatorLogin !== null && author.toLowerCase() === operatorLogin.toLowerCase();
  }
}
