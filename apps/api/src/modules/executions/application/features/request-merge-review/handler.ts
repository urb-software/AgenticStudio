import { Inject, Injectable } from '@nestjs/common';
import {
  RUN_BRANCH_REVIEWS,
  RUN_START_POINTS,
  type RunBranchReviews,
  type RunStartPoints,
} from '../../../../projects/contracts/index.js';
import { RunMergeReview } from '../../../domain/entities/run-merge-review.js';
import { MergeReviewRefusedError } from '../../../domain/errors/run-merge-review-errors.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';
import {
  RUN_MERGE_REVIEW_REPOSITORY,
  type RunMergeReviewRepository,
} from '../../../domain/repositories/run-merge-review-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { MergeReviewDeadline } from '../../../domain/value-objects/merge-review-deadline.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface RequestMergeReviewInput {
  runId: string;
}

export interface RequestMergeReviewResult {
  /** Identifies this request: the preparation stores its outcome only for it. */
  requestedAt: Date;
}

/**
 * Claims the Run's review row; the caller then prepares it in the background. Throws
 * {@link RunNotFoundError} or {@link MergeReviewRefusedError}.
 */
@Injectable()
export class RequestMergeReviewHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_MERGE_REVIEW_REPOSITORY) private readonly reviews: RunMergeReviewRepository,
    @Inject(RUN_START_POINTS) private readonly startPoints: RunStartPoints,
    @Inject(RUN_BRANCH_REVIEWS) private readonly branchReviews: RunBranchReviews,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: RequestMergeReviewInput): Promise<RequestMergeReviewResult> {
    const run = isRunId(input.runId) ? await this.runs.findById(input.runId) : null;
    if (!run) throw new RunNotFoundError();
    const refusal = run.mergeReviewRefusal();
    if (refusal !== null) throw new MergeReviewRefusedError(refusal);
    if (!this.branchReviews.supported()) throw new MergeReviewRefusedError('unsupported_platform');
    const start = await this.startPoints.forProject(run.projectId);
    if (start.status !== 'ready') throw new MergeReviewRefusedError('repository_not_ready');
    const now = this.clock.now();
    const claimed = await this.reviews.claim(
      RunMergeReview.request(run.id, now),
      MergeReviewDeadline.at(now).staleBefore,
    );
    if (!claimed) throw new MergeReviewRefusedError('review_in_progress');
    return { requestedAt: now };
  }
}
