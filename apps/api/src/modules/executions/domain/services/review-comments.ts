import {
  FOLLOW_UP_AUTHORS_MAX,
  REVIEW_COMMENT_DIFF_CONTEXT_MAX_BYTES,
  REVIEW_COMMENT_TEXT_MAX_BYTES,
  REVIEW_COMMENTS_MAX,
  type ReviewComment,
  type ReviewCommentSet,
} from '../entities/review-comments.js';
import { redactLogText } from './log-redaction.js';

/** Control characters other than the line break and the tab (PostgreSQL's JSON cannot hold NUL). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** `text` cut to at most `maxBytes` UTF-8 bytes at a character boundary. */
function cutToBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  // Back off continuation bytes (10xxxxxx) so no character is split.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), cut: true };
}

/**
 * The comments a worker read, as Studio stores them (Issue #146): token-shaped strings and the
 * Run's known secret values redacted, control characters removed, each text and diff context cut
 * to its size in UTF-8 bytes (after the redaction, which can change a text's length), and at most
 * {@link REVIEW_COMMENTS_MAX} kept (the latest). `truncated` says that anything was cut or left
 * out. The text stays plain text: nothing here interprets markup or links.
 */
export function sanitizeReviewComments(
  comments: readonly ReviewComment[],
  alreadyTruncated: boolean,
  known: readonly string[],
): { comments: ReviewComment[]; truncated: boolean } {
  let truncated = alreadyTruncated;
  const clean = (text: string) => redactLogText(text, known).replace(CONTROL, '');
  const kept = comments.slice(-REVIEW_COMMENTS_MAX);
  if (kept.length < comments.length) truncated = true;
  const result = kept.map((comment): ReviewComment => {
    const text = cutToBytes(clean(comment.text), REVIEW_COMMENT_TEXT_MAX_BYTES);
    const context =
      comment.diffContext === undefined
        ? undefined
        : cutToBytes(clean(comment.diffContext), REVIEW_COMMENT_DIFF_CONTEXT_MAX_BYTES);
    // A login that redaction would change is no login: it is not shown half-masked.
    const author =
      redactLogText(comment.author, known) === comment.author ? comment.author : 'unknown';
    const textCut = text.cut || comment.textCut === true;
    if (textCut || (context?.cut ?? false)) truncated = true;
    return {
      id: comment.id,
      author,
      kind: comment.kind,
      ...(comment.path === undefined ? {} : { path: clean(comment.path).slice(0, 500) || 'file' }),
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

/** A set's comments by the ids the operator selected, in the set's order; `null` if any is unknown. */
export function selectReviewComments(
  set: Pick<ReviewCommentSet, 'comments'>,
  ids: readonly string[],
): ReviewComment[] | null {
  const wanted = new Set(ids);
  if (wanted.size !== ids.length) return null;
  const selected = set.comments.filter((comment) => wanted.has(comment.id));
  return selected.length === wanted.size ? selected : null;
}

/** The distinct authors of the comments, in order of appearance, at most the Follow-up's cap. */
export function distinctAuthors(comments: readonly ReviewComment[]): string[] {
  return [...new Set(comments.map((comment) => comment.author))].slice(0, FOLLOW_UP_AUTHORS_MAX);
}

/** Whether a comment was written by the operator's own account (exact, case-insensitive). */
export function isByOperator(author: string, operatorLogin: string | null): boolean {
  return operatorLogin !== null && author.toLowerCase() === operatorLogin.toLowerCase();
}
