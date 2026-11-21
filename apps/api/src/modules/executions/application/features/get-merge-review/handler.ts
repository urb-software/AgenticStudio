import { Inject, Injectable } from '@nestjs/common';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';
import {
  RUN_MERGE_REVIEW_REPOSITORY,
  type RunMergeReviewRepository,
} from '../../../domain/repositories/run-merge-review-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import type { MergeReviewState } from '../../../domain/value-objects/merge-review-state.js';
import type { RunDiffFileStatus } from '../../../domain/value-objects/run-diff-file-status.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface GetMergeReviewInput {
  runId: string;
}

export interface GetMergeReviewResult {
  state: MergeReviewState;
  runCommit?: string;
  integrationCommit?: string;
  files: {
    path: string;
    previousPath?: string;
    status: RunDiffFileStatus;
    binary?: true;
    cut: boolean;
  }[];
  truncated: boolean;
  failure?: string;
}

/** Throws {@link RunNotFoundError}. A review no request was made for is `none`. */
@Injectable()
export class GetMergeReviewHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_MERGE_REVIEW_REPOSITORY) private readonly reviews: RunMergeReviewRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: GetMergeReviewInput): Promise<GetMergeReviewResult> {
    const run = isRunId(input.runId) ? await this.runs.findById(input.runId) : null;
    if (!run) throw new RunNotFoundError();
    const review = await this.reviews.find(run.id);
    if (!review) return { state: 'none', files: [], truncated: false };
    const now = this.clock.now();
    const failure = review.failureAt(now);
    return {
      state: review.stateAt(now, run.latestKnownHead()),
      ...(review.runCommit === null ? {} : { runCommit: review.runCommit }),
      ...(review.integrationCommit === null ? {} : { integrationCommit: review.integrationCommit }),
      files: review.files.map((file) => ({
        path: file.path,
        ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
        status: file.status,
        ...(file.binary ? { binary: true as const } : {}),
        cut: file.cut,
      })),
      truncated: review.truncated,
      ...(failure === null ? {} : { failure }),
    };
  }
}
