import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../domain/entities/run.js';
import { canRefreshPullRequest } from '../../domain/entities/run-lookup.js';
import type { ReviewCommentScope, ReviewComments } from '../../domain/entities/review-comments.js';
import {
  REVIEW_COMMENT_REPOSITORY,
  type ReviewCommentRepository,
} from '../../domain/repositories/review-comment-repository.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../domain/repositories/run-lookup-repository.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { OPERATOR_LOGIN, type OperatorLogin } from '../../ports/operator-login.js';
import { PullRequestNotRefreshableError } from '../refresh-pull-request/handler.js';

/**
 * Command (Issue #146): the operator asks for the Review comments of the Run's pull request to be
 * loaded. Studio only records a request; an agent worker reads them through the Agent account and
 * reports them, and Studio keeps them for the operator to look at. The request starts no agent and
 * sends nothing: sending is the normal Follow-up, with the comments the operator selects. For
 * `since_last_result` a comment counts as new when it was created after the end of the Run's
 * latest part (the Run's finish time; none while the Run has not finished: then every unresolved
 * one counts). When a load is under way already, it is that one. Throws {@link RunNotFoundError}
 * or {@link PullRequestNotRefreshableError} (no pull request to read).
 */
@Injectable()
export class LoadReviewCommentsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
    @Inject(REVIEW_COMMENT_REPOSITORY) private readonly comments: ReviewCommentRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OPERATOR_LOGIN) private readonly operator: OperatorLogin,
  ) {}

  async execute(
    runId: string,
    scope: ReviewCommentScope,
  ): Promise<{ view: ReviewComments; operatorLogin: string | null }> {
    const found = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!found) throw new RunNotFoundError();
    if (!canRefreshPullRequest(found)) throw new PullRequestNotRefreshableError();
    const outcome = await this.lookups.request(found.id, 'review_comments', this.clock.now(), {
      scope,
      since: scope === 'since_last_result' ? found.finishedAt : null,
    });
    if (outcome === 'not_possible') throw new PullRequestNotRefreshableError();
    return {
      view: await this.comments.findReviewComments(found.id),
      operatorLogin: this.operator.login,
    };
  }
}
