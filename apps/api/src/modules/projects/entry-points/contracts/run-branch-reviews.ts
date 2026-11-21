import { Injectable } from '@nestjs/common';
import type {
  MergeDiffLimits,
  MergeDiffResult,
  RunBranchFetchResult,
  RunBranchReviews,
} from '../../contracts/index.js';
import { FetchForReviewHandler } from '../../application/features/fetch-for-review/handler.js';
import { GetReviewSupportHandler } from '../../application/features/get-review-support/handler.js';
import { MergeDiffHandler } from '../../application/features/merge-diff/handler.js';

/**
 * The driving adapter for another module's call through `contracts/`: it maps the call to the
 * handlers and holds no rule.
 */
@Injectable()
export class ProjectRunBranchReviews implements RunBranchReviews {
  constructor(
    private readonly fetchHandler: FetchForReviewHandler,
    private readonly diffHandler: MergeDiffHandler,
    private readonly supportHandler: GetReviewSupportHandler,
  ) {}

  supported(): boolean {
    return this.supportHandler.execute({}).supported;
  }

  fetchForReview(
    projectId: string,
    runId: string,
    runBranch: string,
  ): Promise<RunBranchFetchResult> {
    return this.fetchHandler.execute({ projectId, runId, runBranch });
  }

  mergeDiff(
    projectId: string,
    runCommit: string,
    integrationCommit: string,
    limits: MergeDiffLimits,
  ): Promise<MergeDiffResult> {
    return this.diffHandler.execute({ projectId, runCommit, integrationCommit, limits });
  }
}
