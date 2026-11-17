import type { RunLookup } from '../entities/run-lookup.js';
import type { LookupHandOutRule } from '../value-objects/lookup-hand-out-rule.js';
import type { ReviewCommentsLoad } from '../entities/run-lookup.js';
import type { LookupKind } from '../value-objects/run-lookup.js';
import type { ClaimedLookup } from '../entities/run-lookup.js';

/** DI token for the {@link RunLookupRepository} adapter. */
export const RUN_LOOKUP_REPOSITORY = Symbol('RUN_LOOKUP_REPOSITORY');

/**
 * The store of lookups (Issue #142): requests Studio records for the agent worker. A lookup's
 * rules are the {@link RunLookup}'s own; what the Run, the prepared Follow-up or the Review comments
 * get from an answer is saved by the same transaction through their own repositories (the
 * module's `RunTransactions`). What stays here, besides loading and saving, is what no single lookup
 * can do: handing out the waiting requests (`claim`, one atomic step under the claim lock, paired
 * with {@link LookupHandOutRule}). At most one request is open per Run and kind; a partial unique
 * index backs that in the schema.
 */
export interface RunLookupRepository {
  /** Stores a new request. */
  add(lookup: RunLookup): Promise<void>;

  /** Stores what changed on a lookup: its status, claim, retry, finish, error and result. */
  save(lookup: RunLookup): Promise<void>;

  /** The lookup with this id, or `null`. */
  findById(id: string): Promise<RunLookup | null>;

  /** The Run's open lookup (requested or claimed) of `kind`, or `null`. */
  findOpen(runId: string, kind: LookupKind): Promise<RunLookup | null>;

  /**
   * Hands up to the rule's limit of waiting requests to `workerId`, oldest first, first returning
   * the claims older than the lease to the queue (all as the rule says). Any worker may claim: a
   * lookup needs no Working copy. Joins the Run for what the worker needs to answer (its remote,
   * pull request and branches), read-only.
   */
  claim(workerId: string, rule: LookupHandOutRule): Promise<ClaimedLookup[]>;

  /** Removes lookups that finished (done or failed) before `before`; returns how many. */
  deleteFinishedBefore(before: Date): Promise<number>;

  /** Where the latest `review_comments` load of the Run stands; an unknown Run has no load. */
  findReviewCommentsLoad(runId: string): Promise<ReviewCommentsLoad>;
}
