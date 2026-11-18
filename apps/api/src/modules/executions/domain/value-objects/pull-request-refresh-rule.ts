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
}
