import type { ReviewCommentsSnapshot } from './review-comments-snapshot.js';
import type { FollowUpComments } from '../value-objects/follow-up-comments.js';
import type { LogRedaction } from '../value-objects/log-redaction.js';
import { ReviewComment, type ReviewCommentInput } from '../value-objects/review-comment.js';
import type { ReviewCommentScope } from '../value-objects/review-comment-scope.js';

/** What a pull request's comments are loaded from: the Git host's answer. */
export interface ReviewCommentsLoad {
  scope: ReviewCommentScope;
  comments: readonly ReviewCommentInput[];
  /** The Git host already left some out. */
  truncated: boolean;
  redaction: LogRedaction;
  loadedAt: Date;
}

/** What people wrote on a Run's pull request, as its latest load left it. */
export class ReviewComments {
  private static readonly AUTHORS_MAX = 20;

  readonly scope: ReviewCommentScope;
  readonly comments: readonly ReviewComment[];
  readonly truncated: boolean;
  readonly loadedAt: Date;

  private constructor(
    scope: ReviewCommentScope,
    comments: readonly ReviewComment[],
    truncated: boolean,
    loadedAt: Date,
  ) {
    this.scope = scope;
    this.comments = comments;
    this.truncated = truncated;
    this.loadedAt = loadedAt;
  }

  /**
   * Redacts, removes control characters and cuts each text to its byte size (after the redaction,
   * which can change its length); keeps at most the latest {@link ReviewComment.SET_MAX}.
   */
  static load(input: ReviewCommentsLoad): ReviewComments {
    let truncated = input.truncated;
    const kept = input.comments.slice(-ReviewComment.SET_MAX);
    if (kept.length < input.comments.length) truncated = true;
    const comments = kept.map((raw) => {
      const comment = ReviewComment.load(raw, input.redaction);
      if (comment.textCut === true || comment.contextWasCut) truncated = true;
      return comment;
    });
    return new ReviewComments(input.scope, comments, truncated, input.loadedAt);
  }

  static restore(data: ReviewCommentsSnapshot): ReviewComments {
    return new ReviewComments(
      data.scope,
      data.comments.map((comment) => ReviewComment.restore(comment)),
      data.truncated,
      data.loadedAt,
    );
  }

  snapshot(): ReviewCommentsSnapshot {
    return {
      scope: this.scope,
      comments: this.comments.map((comment) => comment.snapshot()),
      truncated: this.truncated,
      loadedAt: this.loadedAt,
    };
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
    const subset = new ReviewComments(this.scope, selected, this.truncated, this.loadedAt);
    return { count: selected.length, authors: subset.distinctAuthors() };
  }

  distinctAuthors(): string[] {
    return [...new Set(this.comments.map((comment) => comment.author))].slice(
      0,
      ReviewComments.AUTHORS_MAX,
    );
  }
}
