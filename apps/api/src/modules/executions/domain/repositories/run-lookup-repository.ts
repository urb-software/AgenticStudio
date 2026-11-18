import type { RunLookup } from '../entities/run-lookup.js';
import type { LookupHandOutRule } from '../value-objects/lookup-hand-out-rule.js';
import type { ReviewCommentScope } from '../value-objects/review-comments.js';
import type { LookupKind } from '../value-objects/run-lookup.js';

export interface ClaimedLookup {
  id: string;
  kind: LookupKind;
  runId: string;
  remoteUrl: string;
  pullRequestNumber: number;
  runBranch: string;
  integrationBranch: string;
  reviewComments?: { scope: ReviewCommentScope; since?: Date };
}

export interface ReviewCommentsLoad {
  loading: boolean;
  /** Redacted; null unless the latest load failed. */
  error: string | null;
}

/** DI token for the {@link RunLookupRepository} adapter. */
export const RUN_LOOKUP_REPOSITORY = Symbol('RUN_LOOKUP_REPOSITORY');

/**
 * At most one request is open per Run and kind; a partial unique index backs that in the schema.
 * `claim` is one atomic step under the claim lock, paired with {@link LookupHandOutRule}.
 */
export interface RunLookupRepository {
  add(lookup: RunLookup): Promise<void>;

  save(lookup: RunLookup): Promise<void>;

  findById(id: string): Promise<RunLookup | null>;

  /**
   * Read `FOR UPDATE`, so a claim between the read and the save is seen, not overwritten. The lock
   * holds only on a transaction-bound repository; on the plain one it ends at once.
   */
  findByIdForUpdate(id: string): Promise<RunLookup | null>;

  /** Open means requested or claimed. */
  findOpen(runId: string, kind: LookupKind): Promise<RunLookup | null>;

  /** Oldest first, first returning the claims older than the lease to the queue. Any worker may claim. */
  claim(workerId: string, rule: LookupHandOutRule): Promise<ClaimedLookup[]>;

  /** Returns how many were removed. */
  deleteFinishedBefore(before: Date): Promise<number>;

  /** An unknown Run has no load. */
  findReviewCommentsLoad(runId: string): Promise<ReviewCommentsLoad>;
}
