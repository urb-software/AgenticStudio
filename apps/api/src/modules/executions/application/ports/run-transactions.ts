import type { PreparedFollowUpRepository } from '../../domain/repositories/prepared-follow-up-repository.js';
import type { ReviewCommentRepository } from '../../domain/repositories/review-comment-repository.js';
import type { RunDiffRepository } from '../../domain/repositories/run-diff-repository.js';
import type { RunLookupRepository } from '../../domain/repositories/run-lookup-repository.js';
import type { RunRepository } from '../../domain/repositories/run-repository.js';

export const RUN_TRANSACTIONS = Symbol('RUN_TRANSACTIONS');

export interface RunTransactionRepositories {
  runs: RunRepository;
  lookups: RunLookupRepository;
  reviewComments: ReviewCommentRepository;
  preparedFollowUps: PreparedFollowUpRepository;
  diffs: RunDiffRepository;
}

/**
 * **Lock order, the same in every operation:** the Run's row first, then the lookup, then the
 * other roots. Every writer locks the Run first, so operations on one Run cannot deadlock.
 */
export interface RunTransactions {
  /**
   * Runs `work` in one transaction that takes the Run's row lock (`FOR UPDATE`) first; it rolls
   * back if `work` throws. Throws {@link RunNotFoundError} (without calling `work`) for an unknown id.
   */
  withRunLocked<T>(
    runId: string,
    work: (repositories: RunTransactionRepositories) => Promise<T>,
  ): Promise<T>;
}
