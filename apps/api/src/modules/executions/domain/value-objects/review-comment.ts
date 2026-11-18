import { CutText } from './cut-text.js';
import type { LogRedaction } from './log-redaction.js';
import type { ReviewCommentKind } from './review-comment-kind.js';
import type { ReviewVerdict } from './review-verdict.js';

export interface ReviewCommentInput {
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

/** Control characters other than the line break and the tab (PostgreSQL's JSON cannot hold NUL). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Which comments had their diff context cut when they were loaded; never stored. */
const CONTEXT_CUT = new WeakSet<ReviewComment>();

/**
 * Untrusted text: anyone can comment on a public pull request, so nothing reaches an agent unless
 * the operator selects it. A comment loaded from the Git host is redacted, stripped of control
 * characters and cut to its byte size.
 */
export class ReviewComment {
  /** The most comments a set keeps: the latest ones. */
  static readonly SET_MAX = 100;
  static readonly TEXT_MAX_BYTES = 8 * 1024;
  static readonly DIFF_CONTEXT_MAX_BYTES = 2 * 1024;
  private static readonly PATH_MAX_LENGTH = 500;

  readonly id: string;
  readonly author: string;
  readonly kind: ReviewCommentKind;
  readonly path?: string;
  readonly line?: number;
  readonly diffContext?: string;
  readonly verdict?: ReviewVerdict;
  readonly text: string;
  readonly textCut?: true;
  readonly createdAt: string;

  private constructor(data: ReviewCommentInput) {
    this.id = data.id;
    this.author = data.author;
    this.kind = data.kind;
    if (data.path !== undefined) this.path = data.path;
    if (data.line !== undefined) this.line = data.line;
    if (data.diffContext !== undefined) this.diffContext = data.diffContext;
    if (data.verdict !== undefined) this.verdict = data.verdict;
    this.text = data.text;
    if (data.textCut !== undefined) this.textCut = data.textCut;
    this.createdAt = data.createdAt;
  }

  /**
   * Redacts, removes control characters and cuts the text to its byte size (after the redaction,
   * which can change its length).
   */
  static load(raw: ReviewCommentInput, redaction: LogRedaction): ReviewComment {
    const clean = (text: string) => redaction.text(text).replace(CONTROL, '');
    const text = CutText.of(clean(raw.text), ReviewComment.TEXT_MAX_BYTES);
    const context =
      raw.diffContext === undefined
        ? undefined
        : CutText.of(clean(raw.diffContext), ReviewComment.DIFF_CONTEXT_MAX_BYTES);
    // A login that redaction would change is no login: it is not shown half-masked.
    const author = redaction.text(raw.author) === raw.author ? raw.author : 'unknown';
    const textCut = text.cut || raw.textCut === true;
    const comment = new ReviewComment({
      id: raw.id,
      author,
      kind: raw.kind,
      ...(raw.path === undefined
        ? {}
        : { path: clean(raw.path).slice(0, ReviewComment.PATH_MAX_LENGTH) || 'file' }),
      ...(raw.line === undefined ? {} : { line: raw.line }),
      ...(context === undefined ? {} : { diffContext: context.text }),
      ...(raw.verdict === undefined ? {} : { verdict: raw.verdict }),
      text: text.text,
      ...(textCut ? { textCut: true as const } : {}),
      createdAt: raw.createdAt,
    });
    if (context?.cut ?? false) CONTEXT_CUT.add(comment);
    return comment;
  }

  /** A comment as storage holds it. */
  static restore(stored: ReviewCommentInput): ReviewComment {
    return new ReviewComment(stored);
  }

  /** Whether loading cut its diff context. */
  get contextWasCut(): boolean {
    return CONTEXT_CUT.has(this);
  }

  isBy(operatorLogin: string | null): boolean {
    return operatorLogin !== null && this.author.toLowerCase() === operatorLogin.toLowerCase();
  }

  snapshot(): ReviewCommentInput {
    return {
      id: this.id,
      author: this.author,
      kind: this.kind,
      ...(this.path === undefined ? {} : { path: this.path }),
      ...(this.line === undefined ? {} : { line: this.line }),
      ...(this.diffContext === undefined ? {} : { diffContext: this.diffContext }),
      ...(this.verdict === undefined ? {} : { verdict: this.verdict }),
      text: this.text,
      ...(this.textCut === undefined ? {} : { textCut: this.textCut }),
      createdAt: this.createdAt,
    };
  }
}
