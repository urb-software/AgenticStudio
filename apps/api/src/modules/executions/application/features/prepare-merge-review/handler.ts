import { Inject, Injectable, Logger } from '@nestjs/common';
import { RUN_BRANCH_REVIEWS, type RunBranchReviews } from '../../../../projects/contracts/index.js';
import type { Run } from '../../../domain/entities/run.js';
import { RunMergeReview } from '../../../domain/entities/run-merge-review.js';
import {
  RUN_MERGE_REVIEW_REPOSITORY,
  type RunMergeReviewRepository,
} from '../../../domain/repositories/run-merge-review-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { LogRedaction } from '../../../domain/value-objects/log-redaction.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  MERGE_REVIEW_LIMITS,
  type MergeReviewLimitsSetting,
} from '../../ports/merge-review-limits.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';

export interface PrepareMergeReviewInput {
  runId: string;
  /** The request this preparation is for. */
  requestedAt: Date;
}

export type PrepareMergeReviewResult = void;

const FETCH_FAILURES = {
  repository_not_ready: 'The Repository is not ready. Fetch it, then request the review again.',
  branch_not_found: 'The Run branch no longer exists on the Git host.',
  unsupported_platform: 'Reviews need the API to run on Linux.',
  failed: 'Studio could not fetch the Run branch',
} as const;

const DIFF_FAILURES = {
  repository_not_ready: FETCH_FAILURES.repository_not_ready,
  unsupported_platform: FETCH_FAILURES.unsupported_platform,
  failed: 'Studio could not compute the merge result',
} as const;

function withDetail(reason: string, detail: string | undefined): string {
  return detail ? `${reason}: ${detail}` : `${reason}.`;
}

/**
 * Runs in the background after a request and never throws: every failure is stored as the
 * review's failure. A result for a request a newer one replaced is dropped.
 */
@Injectable()
export class PrepareMergeReviewHandler {
  private readonly logger = new Logger('MergeReview');

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_MERGE_REVIEW_REPOSITORY) private readonly reviews: RunMergeReviewRepository,
    @Inject(RUN_BRANCH_REVIEWS) private readonly branchReviews: RunBranchReviews,
    @Inject(RUN_SECRET_VALUES) private readonly secrets: RunSecretValues,
    @Inject(MERGE_REVIEW_LIMITS) private readonly limits: MergeReviewLimitsSetting,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: PrepareMergeReviewInput): Promise<PrepareMergeReviewResult> {
    const { runId, requestedAt } = input;
    let redaction = LogRedaction.NONE;
    try {
      const run = isRunId(runId) ? await this.runs.findById(runId) : null;
      const review = await this.reviews.find(runId);
      if (!run || review?.storedState !== 'preparing') return;
      if (review.requestedAt.getTime() !== requestedAt.getTime()) return;
      redaction = LogRedaction.of(await this.secrets.forRun(runId));
      await this.reviews.finish(await this.prepare(run, review, redaction));
    } catch (error) {
      this.logger.error(`The merge review of run ${runId} failed: ${(error as Error).name}`);
      const stored = await this.reviews.find(runId).catch(() => null);
      if (
        stored?.storedState === 'preparing' &&
        stored.requestedAt.getTime() === requestedAt.getTime()
      ) {
        await this.reviews
          .finish(stored.failed('The review could not be prepared.', redaction, this.clock.now()))
          .catch(() => false);
      }
    }
  }

  private async prepare(
    run: Run,
    review: RunMergeReview,
    redaction: LogRedaction,
  ): Promise<RunMergeReview> {
    const fail = (reason: string) => review.failed(reason, redaction, this.clock.now());
    const { runBranch } = run;
    if (runBranch === null) return fail('The Run has no known branch to review.');
    const fetched = await this.branchReviews.fetchForReview(run.projectId, run.id, runBranch);
    if (fetched.status !== 'ready') {
      return fail(withDetail(FETCH_FAILURES[fetched.status], fetched.detail));
    }
    const merged = await this.branchReviews.mergeDiff(
      run.projectId,
      fetched.runCommit,
      fetched.integrationCommit,
      this.limits,
    );
    if (merged.status === 'conflicting') return fail(RunMergeReview.CONFLICTS);
    if (merged.status !== 'computed') {
      return fail(withDetail(DIFF_FAILURES[merged.status], merged.detail));
    }
    return review.ready(
      {
        runCommit: fetched.runCommit,
        integrationCommit: fetched.integrationCommit,
        files: merged.files,
        truncated: merged.truncated,
        redaction,
        limits: this.limits,
      },
      this.clock.now(),
    );
  }
}
