import type { ReviewCommentsSnapshot } from './review-comments-snapshot.js';
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

/** What people wrote on a Run's pull request, as its latest load left it; an aggregate root of its own. */
export class ReviewComments {
  readonly scope: ReviewCommentScope;
  readonly comments: readonly ReviewComment[];
  readonly truncated: boolean;
  readonly loadedAt: Date;

  private constructor(data: ReviewCommentsSnapshot) {
    this.scope = data.scope;
    this.comments = data.comments;
    this.truncated = data.truncated;
    this.loadedAt = data.loadedAt;
  }

  static load(data: ReviewCommentsSnapshot): ReviewComments {
    return new ReviewComments(data);
  }

  static restore(data: ReviewCommentsSnapshot): ReviewComments {
    return new ReviewComments(data);
  }

  snapshot(): ReviewCommentsSnapshot {
    return {
      scope: this.scope,
      comments: this.comments.map((comment) => ({ ...comment })),
      truncated: this.truncated,
      loadedAt: this.loadedAt,
    };
  }

  /**
   * Redacts, removes control characters and cuts each text to its byte size (after the redaction,
   * which can change its length); keeps at most the latest {@link REVIEW_COMMENTS_MAX}.
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

  /** `null` if any id is unknown. */
  select(ids: readonly string[]): ReviewComment[] | null {
    const wanted = new Set(ids);
    if (wanted.size !== ids.length) return null;
    const selected = this.comments.filter((comment) => wanted.has(comment.id));
    return selected.length === wanted.size ? selected : null;
  }

  /** `null` if any id is not in the set; the Run never sees the comments themselves. */
  selection(ids: readonly string[]): FollowUpComments | null {
    const selected = this.select(ids);
    if (selected === null) return null;
    return { count: selected.length, authors: ReviewComments.distinctAuthors(selected) };
  }

  static distinctAuthors(comments: readonly ReviewComment[]): string[] {
    return [...new Set(comments.map((comment) => comment.author))].slice(0, FOLLOW_UP_AUTHORS_MAX);
  }

  static isByOperator(author: string, operatorLogin: string | null): boolean {
    return operatorLogin !== null && author.toLowerCase() === operatorLogin.toLowerCase();
  }
}
