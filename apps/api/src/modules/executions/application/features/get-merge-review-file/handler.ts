import { Inject, Injectable } from '@nestjs/common';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';
import { MergeReviewFileNotFoundError } from '../../../domain/errors/run-merge-review-errors.js';
import {
  RUN_MERGE_REVIEW_REPOSITORY,
  type RunMergeReviewRepository,
} from '../../../domain/repositories/run-merge-review-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import type { RunDiffFileStatus } from '../../../domain/value-objects/run-diff-file-status.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';

export interface GetMergeReviewFileInput {
  runId: string;
  path: string;
}

export interface GetMergeReviewFileResult {
  path: string;
  previousPath?: string;
  status: RunDiffFileStatus;
  patch?: string;
  binary?: true;
  cut: boolean;
}

/**
 * The patch was redacted when stored. Throws {@link RunNotFoundError} or
 * {@link MergeReviewFileNotFoundError}.
 */
@Injectable()
export class GetMergeReviewFileHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_MERGE_REVIEW_REPOSITORY) private readonly reviews: RunMergeReviewRepository,
  ) {}

  async execute(input: GetMergeReviewFileInput): Promise<GetMergeReviewFileResult> {
    if (!isRunId(input.runId) || !(await this.runs.exists(input.runId))) {
      throw new RunNotFoundError();
    }
    const file = (await this.reviews.find(input.runId))?.file(input.path);
    if (!file) throw new MergeReviewFileNotFoundError();
    return {
      path: file.path,
      ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
      status: file.status,
      ...(file.patch === undefined ? {} : { patch: file.patch }),
      ...(file.binary ? { binary: true as const } : {}),
      cut: file.cut,
    };
  }
}
