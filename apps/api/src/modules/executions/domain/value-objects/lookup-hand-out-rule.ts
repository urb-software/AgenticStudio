import { LOOKUP_CLAIM_MAX, LOOKUP_LEASE_SECONDS, type LookupStatus } from './run-lookup.js';

/** What the hand-out rule reads of a lookup. */
export interface LookupHandOutView {
  id: string;
  runId: string;
  status: LookupStatus;
  requestedAt: Date;
  claimedAt: Date | null;
  retryAt: Date | null;
}

/** What the hand-out rule reads of a lookup's Run: whether there is a pull request to look up. */
export interface LookupRunView {
  id: string;
  hasPullRequest: boolean;
  hasRunBranch: boolean;
}

/**
 * The hand-out rule of lookups (Issue #142): which lookups an agent worker is handed when it asks
 * for them, and which claims it takes back.
 *
 * - **Back to the queue:** a lookup claimed for at least `leaseSeconds` goes back to `requested`
 *   before the selection, its worker forgotten (a worker that never answered loses it).
 * - **Which lookups:** `requested` ones, not those a rate limit asks to wait for (their retry time
 *   is after now), whose Run still has a pull request and a known Run branch (the lookup is limited
 *   to that branch). Any worker may take them: a lookup needs no Working copy.
 * - **Order and number:** oldest request first, ties by id, at most `limit` (the claim max).
 *
 * The store hands them out in one atomic step with the statements this rule supplies the numbers
 * for, skipping lookups another claim holds; {@link LookupHandOutRule.next} is the same rule over a
 * set of lookups, which a test uses to prove the statements follow it.
 */
export class LookupHandOutRule {
  private constructor(
    readonly now: Date,
    readonly leaseSeconds: number,
    readonly limit: number,
  ) {}

  /** The rule at `now`, with the lease and claim limit of the domain unless told otherwise. */
  static at(now: Date, options: { leaseSeconds?: number; limit?: number } = {}): LookupHandOutRule {
    return new LookupHandOutRule(
      now,
      options.leaseSeconds ?? LOOKUP_LEASE_SECONDS,
      options.limit ?? LOOKUP_CLAIM_MAX,
    );
  }

  /** Whether a claimed lookup has outlived its lease and goes back to the queue. */
  claimExpired(lookup: Pick<LookupHandOutView, 'status' | 'claimedAt'>): boolean {
    return (
      lookup.status === 'claimed' &&
      lookup.claimedAt !== null &&
      lookup.claimedAt.getTime() <= this.now.getTime() - this.leaseSeconds * 1000
    );
  }

  /** Whether a lookup that is waiting (after the expired claims are back) may be handed out now. */
  takes(lookup: LookupHandOutView, run: LookupRunView | undefined): boolean {
    return (
      (lookup.status === 'requested' || this.claimExpired(lookup)) &&
      (lookup.retryAt === null || lookup.retryAt.getTime() <= this.now.getTime()) &&
      run !== undefined &&
      run.hasPullRequest &&
      run.hasRunBranch
    );
  }

  /** The queue order: the oldest request first, ties by id. */
  static readonly queueOrder = (a: LookupHandOutView, b: LookupHandOutView): number =>
    a.requestedAt.getTime() - b.requestedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  /** The lookups to hand out among `lookups` (all lookups), at most the limit. */
  next<T extends LookupHandOutView>(lookups: readonly T[], runs: readonly LookupRunView[]): T[] {
    return [...lookups]
      .sort(LookupHandOutRule.queueOrder)
      .filter((lookup) =>
        this.takes(
          lookup,
          runs.find((run) => run.id === lookup.runId),
        ),
      )
      .slice(0, this.limit);
  }
}
