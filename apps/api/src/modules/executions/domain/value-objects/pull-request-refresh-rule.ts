import type { PullRequestRefreshFacts } from './pull-request-refresh-facts.js';

/**
 * Which Runs get their pull request refreshed once a day, and how long finished lookups are kept.
 */
export class PullRequestRefreshRule {
  static readonly AGE_HOURS = 24;
  static readonly FINISHED_LOOKUPS_KEPT_DAYS = 7;
  static readonly BATCH = 200;

  private constructor(readonly now: Date) {}

  static at(now: Date): PullRequestRefreshRule {
    return new PullRequestRefreshRule(now);
  }

  get staleBefore(): Date {
    return new Date(this.now.getTime() - PullRequestRefreshRule.AGE_HOURS * 60 * 60 * 1000);
  }

  get finishedLookupsBefore(): Date {
    return new Date(
      this.now.getTime() - PullRequestRefreshRule.FINISHED_LOOKUPS_KEPT_DAYS * 24 * 60 * 60 * 1000,
    );
  }

  /**
   * An unfinished or open pull request whose last attempt, or last success when none was made,
   * is older than a day, and that has no refresh requested.
   */
  dueDaily(facts: PullRequestRefreshFacts): boolean {
    const attempt = facts.lastAttemptAt ?? facts.refreshedAt;
    return (
      facts.hasPullRequest &&
      facts.hasWorkingCopy &&
      facts.refreshRequestedAt === null &&
      (facts.pullRequestState === null ||
        facts.pullRequestState === 'draft' ||
        facts.pullRequestState === 'open') &&
      (attempt === null || attempt < this.staleBefore)
    );
  }

  /** Oldest attempt first, a Run never attempted first, then by id. */
  dailyOrder(a: PullRequestRefreshFacts, b: PullRequestRefreshFacts): number {
    const first = a.lastAttemptAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const second = b.lastAttemptAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (first !== second) return first < second ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
}
