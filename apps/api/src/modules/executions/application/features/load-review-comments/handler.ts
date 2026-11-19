import { Inject, Injectable } from '@nestjs/common';
import type { ReviewCommentKind } from '../../../domain/value-objects/review-comment-kind.js';
import type { ReviewVerdict } from '../../../domain/value-objects/review-verdict.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type ReviewCommentScope } from '../../../domain/value-objects/review-comment-scope.js';
import {
  FollowUpNotAllowedError,
  RunNotFoundError,
  PullRequestNotRefreshableError,
} from '../../../domain/errors/run-errors.js';
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
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RunLookupRequests } from '../../run-lookup-requests.js';
import { OPERATOR_LOGIN, type OperatorLogin } from '../../ports/operator-login.js';
import { ReviewCommentsLoadRunningError } from '../../../domain/errors/review-comments-errors.js';

export interface LoadReviewCommentsInput {
  runId: string;
  scope: ReviewCommentScope;
}

export interface LoadReviewCommentsComment {
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
  byOperator: boolean;
}

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
 * Throws {@link RunNotFoundError}, {@link PullRequestNotRefreshableError},
 * {@link FollowUpNotAllowedError} or {@link ReviewCommentsLoadRunningError}.
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
      this.comments.find(found.id),
      this.lookups.findReviewCommentsLoad(found.id),
    ]);
    const operatorLogin = this.operator.login;
    return {
      operatorLogin,
      comments: (set?.comments ?? []).map((comment) => ({
        id: comment.id,
        author: comment.author,
        kind: comment.kind,
        ...(comment.path === undefined ? {} : { path: comment.path }),
        ...(comment.line === undefined ? {} : { line: comment.line }),
        ...(comment.diffContext === undefined ? {} : { diffContext: comment.diffContext }),
        ...(comment.verdict === undefined ? {} : { verdict: comment.verdict }),
        text: comment.text,
        ...(comment.textCut === undefined ? {} : { textCut: comment.textCut }),
        createdAt: comment.createdAt,
        byOperator: comment.isBy(operatorLogin),
      })),
      truncated: set?.truncated ?? false,
      scope: set?.scope ?? null,
      loadedAt: set?.loadedAt ?? null,
      loading: load.loading,
      error: load.error,
    };
  }
}
