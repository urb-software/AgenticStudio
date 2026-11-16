import {
  cutToBytes,
  REVIEW_COMMENT_AUTHOR_MAX_LENGTH,
  REVIEW_COMMENT_DIFF_CONTEXT_MAX_BYTES,
  REVIEW_COMMENT_DIFF_CONTEXT_MAX_LINES,
  REVIEW_COMMENT_PATH_MAX_LENGTH,
  REVIEW_COMMENT_TEXT_MAX_BYTES,
  REVIEW_COMMENTS_MAX,
  type ReviewComment,
  type ReviewCommentScope,
  type ReviewCommentsResult,
} from '@agentic-studio/contracts';
import { tailBytes } from './check-logs.js';
import type { ConversationCommentReport, InlineCommentReport, ReviewReport } from './github.js';

/**
 * Review comments (Issue #146): the worker turns what the Git host lists into the worker
 * protocol's comments. Everything here is plain text handling: a comment is untrusted (anyone
 * can write one on a public pull request), so it is only cleaned of control characters and held
 * to its size limits; it is never interpreted, and Studio redacts it again before it is stored.
 */

/** What the Git host listed of the pull request, and what to leave out. */
export interface ReviewCommentSources {
  reviews: readonly ReviewReport[];
  inline: readonly InlineCommentReport[];
  conversation: readonly ConversationCommentReport[];
  /** Inline comments in resolved threads. */
  resolved: ReadonlySet<number>;
  /** The Agent account: its own comments are left out (case-insensitive). */
  agentLogin: string;
  /** Whether any listing had more than was read. */
  more: boolean;
}

/** What a lookup asks for. */
export interface ReviewCommentsFilter {
  scope: ReviewCommentScope;
  /** For `since_last_result`: only comments created after this time. */
  since?: string | undefined;
}

/** Control characters other than the line break and the tab. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Text as plain lines: CRLF as LF, control characters removed. */
function plain(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL, '');
}

/** The last lines of a diff hunk (the lines around the comment), cut to its size from the end. */
function diffContextOf(hunk: string | undefined): string | undefined {
  if (hunk === undefined) return undefined;
  const lines = plain(hunk).split('\n');
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  if (lines.length === 0) return undefined;
  return tailBytes(
    lines.slice(-REVIEW_COMMENT_DIFF_CONTEXT_MAX_LINES).join('\n'),
    REVIEW_COMMENT_DIFF_CONTEXT_MAX_BYTES,
  );
}

function verdictOf(state: string): ReviewComment['verdict'] | undefined {
  switch (state) {
    case 'approved':
      return 'approved';
    case 'changes_requested':
      return 'changes_requested';
    case 'commented':
      return 'commented';
    // A pending draft is its author's own, and a dismissed review no longer counts.
    default:
      return undefined;
  }
}

/** A comment as a `ReviewComment`, its text cut to the limit; `cut` says it was. */
function withText(
  base: Omit<ReviewComment, 'text' | 'textCut'>,
  body: string,
): { comment: ReviewComment; cut: boolean } {
  const { text, cut } = cutToBytes(plain(body), REVIEW_COMMENT_TEXT_MAX_BYTES);
  return { comment: { ...base, text, ...(cut ? { textCut: true as const } : {}) }, cut };
}

/** A valid timestamp as ISO text, or `undefined`. */
function isoOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/**
 * The unresolved Review comments of a pull request (Issue #146), oldest first: review summaries
 * (with their verdict; the summary of a review that only wraps inline comments is left out),
 * inline comments (with file, line and the diff lines around them) and conversation comments.
 * Left out: the Agent account's own comments, inline comments of resolved threads, and, for
 * `since_last_result`, comments created before `since`. At most
 * {@link REVIEW_COMMENTS_MAX} are kept (the latest); `truncated` says that anything was left
 * out for the limits or that a text was cut.
 */
export function buildReviewComments(
  sources: ReviewCommentSources,
  filter: ReviewCommentsFilter,
): ReviewCommentsResult {
  const agent = sources.agentLogin.toLowerCase();
  const since =
    filter.scope === 'since_last_result' && filter.since !== undefined
      ? Date.parse(filter.since)
      : undefined;
  const own = (author: string) => author.toLowerCase() === agent;
  const isNew = (createdAt: string) => since === undefined || Date.parse(createdAt) > since;
  const author = (login: string) => login.slice(0, REVIEW_COMMENT_AUTHOR_MAX_LENGTH) || 'ghost';
  const kept: ReviewComment[] = [];
  // Pages of a listing are read one after another, so a comment written or removed meanwhile can
  // show up twice: an id counts once.
  const seen = new Set<string>();
  let cutAny = false;
  const keep = (built: { comment: ReviewComment; cut: boolean }) => {
    if (seen.has(built.comment.id)) return;
    seen.add(built.comment.id);
    cutAny ||= built.cut;
    kept.push(built.comment);
  };

  for (const review of sources.reviews) {
    const verdict = verdictOf(review.state);
    const createdAt = isoOf(review.submittedAt);
    if (verdict === undefined || createdAt === undefined || own(review.author)) continue;
    if (!isNew(createdAt)) continue;
    // A review that only wraps inline comments has no summary of its own to send.
    if (verdict === 'commented' && review.body.trim() === '') continue;
    keep(
      withText(
        {
          id: `review-${review.id}`,
          author: author(review.author),
          kind: 'review',
          verdict,
          createdAt,
        },
        review.body,
      ),
    );
  }
  for (const comment of sources.inline) {
    const createdAt = isoOf(comment.createdAt);
    if (createdAt === undefined || own(comment.author) || sources.resolved.has(comment.id))
      continue;
    if (!isNew(createdAt)) continue;
    const diffContext = diffContextOf(comment.diffHunk);
    keep(
      withText(
        {
          id: `inline-${comment.id}`,
          author: author(comment.author),
          kind: 'inline',
          path: plain(comment.path).slice(0, REVIEW_COMMENT_PATH_MAX_LENGTH) || 'file',
          ...(comment.line === undefined ? {} : { line: comment.line }),
          ...(diffContext === undefined ? {} : { diffContext }),
          createdAt,
        },
        comment.body,
      ),
    );
  }
  for (const comment of sources.conversation) {
    const createdAt = isoOf(comment.createdAt);
    if (createdAt === undefined || own(comment.author) || !isNew(createdAt)) continue;
    keep(
      withText(
        {
          id: `conversation-${comment.id}`,
          author: author(comment.author),
          kind: 'conversation',
          createdAt,
        },
        comment.body,
      ),
    );
  }

  kept.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const comments = kept.slice(-REVIEW_COMMENTS_MAX);
  return {
    comments,
    truncated: sources.more || cutAny || comments.length < kept.length,
  };
}
