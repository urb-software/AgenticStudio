import { Inject, Injectable } from '@nestjs/common';
import { ReviewComments } from '../../../domain/entities/review-comments.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import type {
  ReviewComment,
  ReviewCommentScope,
} from '../../../domain/value-objects/review-comments.js';
import {
  REVIEW_COMMENT_REPOSITORY,
  type ReviewCommentRepository,
} from '../../../domain/repositories/review-comment-repository.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../../domain/repositories/run-lookup-repository.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import { OPERATOR_LOGIN, type OperatorLogin } from '../../ports/operator-login.js';

export interface GetReviewCommentsInput {
  runId: string;
}

/** One comment with whether the operator's own account wrote it (Issue #146). */
export type GetReviewCommentsComment = ReviewComment & { byOperator: boolean };

/**
 * What the Run page is shown (Issue #146): the loaded comments (each marked as the operator's or
 * not), the configured login, and the state of the latest load.
 */
export interface GetReviewCommentsResult {
  operatorLogin: string | null;
  comments: GetReviewCommentsComment[];
  truncated: boolean;
  scope: ReviewCommentScope | null;
  loadedAt: Date | null;
  loading: boolean;
  error: string | null;
}

/**
 * Query (Issue #146): the Review comments loaded for the Run and the state of the latest load.
 * Reading them starts nothing and sends nothing. Throws {@link RunNotFoundError} (also for an id
 * that is not a UUID).
 */
@Injectable()
export class GetReviewCommentsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(REVIEW_COMMENT_REPOSITORY) private readonly comments: ReviewCommentRepository,
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
    @Inject(OPERATOR_LOGIN) private readonly operator: OperatorLogin,
  ) {}

  async execute(input: GetReviewCommentsInput): Promise<GetReviewCommentsResult> {
    const { runId } = input;
    if (!isRunId(runId) || !(await this.runs.exists(runId))) throw new RunNotFoundError();
    // The loaded set is the Review comments'; where the load stands is read from the lookups.
    const [set, load] = await Promise.all([
      this.comments.findSnapshot(runId),
      this.lookups.findReviewCommentsLoad(runId),
    ]);
    const operatorLogin = this.operator.login;
    return {
      operatorLogin,
      comments: (set?.comments ?? []).map((comment) => ({
        ...comment,
        byOperator: ReviewComments.isByOperator(comment.author, operatorLogin),
      })),
      truncated: set?.truncated ?? false,
      scope: set?.scope ?? null,
      loadedAt: set?.loadedAt ?? null,
      loading: load.loading,
      error: load.error,
    };
  }
}
