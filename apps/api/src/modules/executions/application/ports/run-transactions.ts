import type { PreparedFollowUpRepository } from '../../domain/repositories/prepared-follow-up-repository.js';
import type { ReviewCommentRepository } from '../../domain/repositories/review-comment-repository.js';
import type { RunDiffRepository } from '../../domain/repositories/run-diff-repository.js';
import type { RunLookupRepository } from '../../domain/repositories/run-lookup-repository.js';
import type { RunRepository } from '../../domain/repositories/run-repository.js';

/** DI token for the {@link RunTransactions} adapter. */
export const RUN_TRANSACTIONS = Symbol('RUN_TRANSACTIONS');

/**
 * The repositories of `executions` bound to one transaction: each reads and writes only its own
 * aggregate (a repository never reaches into another root's table), and they commit or roll back
 * together.
 */
export interface RunTransactionRepositories {
  runs: RunRepository;
  lookups: RunLookupRepository;
  reviewComments: ReviewCommentRepository;
  preparedFollowUps: PreparedFollowUpRepository;
  diffs: RunDiffRepository;
}

/**
 * The one place where more than one aggregate of `executions` is changed atomically (backend.md
 * §3 rules 11 and 12): an operation that must change a Run and another root, or that must decide
 * on another root's data under the Run's lock, runs through it. The operations are the Follow-up
 * (the Run, and the Review comments or prepared Follow-up it used up), requesting a lookup (the
 * lookup and the Run's pull request marks), answering a lookup (the lookup, and the Run, the
 * prepared Follow-up or the Review comments it updates) and reporting diffs (the held Run and the
 * Run diff).
 *
 * **Lock order, the same in every operation:** the Run's row first, then the lookup, then the
 * other roots (Review comments, prepared Follow-up, Run diff). A Run is the parent of the rest, and
 * every writer of any of them locks the Run first, so two operations on one Run run one after the
 * other and cannot deadlock. The callback is orchestration only: it loads, calls the entities'
 * methods with facts passed as values, and saves. The rules stay on the entities.
 */
export interface RunTransactions {
  /**
   * Runs `work` in one transaction that takes the Run's row lock (`FOR UPDATE`) before anything
   * else. A transaction that `work` throws from is rolled back and the error reaches the caller.
   * Throws {@link RunNotFoundError} (without calling `work`) when no Run has this id.
   */
  withRunLocked<T>(
    runId: string,
    work: (repositories: RunTransactionRepositories) => Promise<T>,
  ): Promise<T>;
}
