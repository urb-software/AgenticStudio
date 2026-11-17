import { Inject, Injectable } from '@nestjs/common';
import { ReviewComments } from '../../../domain/entities/review-comments.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import {
  type ReviewComment,
  type ReviewCommentScope,
  ReviewCommentsLoadRunningError,
} from '../../../domain/value-objects/review-comments.js';
import { FollowUpNotAllowedError } from '../../../domain/value-objects/run-errors.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';
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
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RunLookupRequests } from '../../run-lookup-requests.js';
import { OPERATOR_LOGIN, type OperatorLogin } from '../../ports/operator-login.js';
import { PullRequestNotRefreshableError } from '../../../domain/value-objects/run-lookup.js';

export interface LoadReviewCommentsInput {
  runId: string;
  scope: ReviewCommentScope;
}

/** One comment with whether the operator's own account wrote it (Issue #146). */
export type LoadReviewCommentsComment = ReviewComment & { byOperator: boolean };

/**
 * What the Run page is shown after the request (Issue #146): the loaded comments (each marked as
 * the operator's or not), the configured login, and the state of the latest load.
 */
export interface LoadReviewCommentsResult {
  operatorLogin: string | null;
  comments: LoadReviewCommentsComment[];
  truncated: boolean;
  scope: ReviewCommentScope | null;
  loadedAt: Date | null;
  loading: boolean;
  error: string | null;
}

/**
 * Command (Issue #146): the operator asks for the Review comments of the Run's pull request to be
 * loaded. Studio only records a request; an agent worker reads them through the Agent account and
 * reports them, and Studio keeps them for the operator to look at. The request starts no agent and
 * sends nothing: sending is the normal Follow-up, with the comments the operator selects. For
 * `since_last_result` a comment counts as new when it was created after the end of the Run's
 * latest part (the Run's finish time; none while the Run has not finished: then every unresolved
 * one counts). Like the page, the API loads only for a Run that can take a Follow-up now. Throws
 * {@link RunNotFoundError}, {@link PullRequestNotRefreshableError} (no pull request to read),
 * {@link FollowUpNotAllowedError} (the Run cannot take a Follow-up: the reason says why) or
 * {@link ReviewCommentsLoadRunningError} (a load is under way already; it keeps its own scope).
 */
@Injectable()
export class LoadReviewCommentsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    private readonly lookupRequests: RunLookupRequests,
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
    @Inject(REVIEW_COMMENT_REPOSITORY) private readonly comments: ReviewCommentRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OPERATOR_LOGIN) private readonly operator: OperatorLogin,
    @Inject(WORKER_STATUS_STORE) private readonly workers: WorkerStatusStore,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
  ) {}

  async execute(input: LoadReviewCommentsInput): Promise<LoadReviewCommentsResult> {
    const { runId, scope } = input;
    const found = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!found) throw new RunNotFoundError();
    if (!found.canRefreshPullRequest()) throw new PullRequestNotRefreshableError();
    const now = this.clock.now();
    const eligibility = found.followUpAvailability(
      {
        holderLastSeen:
          found.claim.lastClaimedBy === null
            ? undefined
            : this.workers.lastSeen(found.claim.lastClaimedBy),
        latest: this.workers.latest(),
      },
      now,
      this.lease.seconds,
    );
    if (!eligibility.allowed) throw new FollowUpNotAllowedError(eligibility.reason);
    const outcome = await this.lookupRequests.request(found.id, 'review_comments', now, {
      scope,
      since: scope === 'since_last_result' ? found.lifecycle.finishedAt : null,
    });
    if (outcome === 'not_possible') throw new PullRequestNotRefreshableError();
    if (outcome === 'open') throw new ReviewCommentsLoadRunningError();
    const [set, load] = await Promise.all([
      this.comments.findSnapshot(found.id),
      this.lookups.findReviewCommentsLoad(found.id),
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
