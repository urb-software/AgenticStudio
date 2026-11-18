import { type LookupStatus } from './lookup-status.js';

export interface LookupHandOutView {
  id: string;
  runId: string;
  status: LookupStatus;
  requestedAt: Date;
  claimedAt: Date | null;
  retryAt: Date | null;
}

export interface LookupRunView {
  id: string;
  hasPullRequest: boolean;
  hasRunBranch: boolean;
}

/**
 * The store hands lookups out in one atomic step, skipping lookups another claim holds; `next` is
 * the same rule in memory, which a test uses to prove the statements follow it.
 */
export class LookupHandOutRule {
  static readonly LEASE_SECONDS = 120;

  static readonly CLAIM_MAX = 5;

  private constructor(
    readonly now: Date,
    readonly leaseSeconds: number,
    readonly limit: number,
  ) {}

  static at(now: Date, options: { leaseSeconds?: number; limit?: number } = {}): LookupHandOutRule {
    return new LookupHandOutRule(
      now,
      options.leaseSeconds ?? LookupHandOutRule.LEASE_SECONDS,
      options.limit ?? LookupHandOutRule.CLAIM_MAX,
    );
  }

  claimExpired(lookup: Pick<LookupHandOutView, 'status' | 'claimedAt'>): boolean {
    return (
      lookup.status === 'claimed' &&
      lookup.claimedAt !== null &&
      lookup.claimedAt.getTime() <= this.now.getTime() - this.leaseSeconds * 1000
    );
  }

  takes(lookup: LookupHandOutView, run: LookupRunView | undefined): boolean {
    return (
      (lookup.status === 'requested' || this.claimExpired(lookup)) &&
      (lookup.retryAt === null || lookup.retryAt.getTime() <= this.now.getTime()) &&
      run !== undefined &&
      run.hasPullRequest &&
      run.hasRunBranch
    );
  }

  static readonly queueOrder = (a: LookupHandOutView, b: LookupHandOutView): number =>
    a.requestedAt.getTime() - b.requestedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

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
