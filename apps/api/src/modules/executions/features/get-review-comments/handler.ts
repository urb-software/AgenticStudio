import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../domain/entities/run.js';
import type { ReviewCommentsView } from '../../domain/entities/review-comments.js';
import { reviewCommentsView } from '../../domain/services/review-comments.js';
import {
  REVIEW_COMMENT_REPOSITORY,
  type ReviewCommentRepository,
} from '../../domain/repositories/review-comment-repository.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';
import { OPERATOR_LOGIN, type OperatorLogin } from '../../ports/operator-login.js';

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
    @Inject(OPERATOR_LOGIN) private readonly operator: OperatorLogin,
  ) {}

  async execute(runId: string): Promise<ReviewCommentsView> {
    if (!isRunId(runId) || (await this.runs.findById(runId)) === null) {
      throw new RunNotFoundError();
    }
    return reviewCommentsView(await this.comments.findReviewComments(runId), this.operator.login);
  }
}
