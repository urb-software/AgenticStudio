/**
 * How long an approval may stay pending: a live request ends well inside it, and an older one died.
 */
export class MergeApprovalLease {
  /** After the approval, three host steps of two calls each, every call cut at 15 seconds. */
  static readonly SECONDS = 600;
  /** The room one more host step may need; no step starts with less left. */
  static readonly STEP_BUDGET_SECONDS = 60;

  private constructor(
    private readonly now: Date,
    readonly staleBefore: Date,
  ) {}

  static at(now: Date): MergeApprovalLease {
    return new MergeApprovalLease(now, new Date(now.getTime() - MergeApprovalLease.SECONDS * 1000));
  }

  isOver(approvedAt: Date): boolean {
    return approvedAt.getTime() < this.staleBefore.getTime();
  }

  allowsAStep(approvedAt: Date): boolean {
    const spent = this.now.getTime() - approvedAt.getTime();
    return spent < (MergeApprovalLease.SECONDS - MergeApprovalLease.STEP_BUDGET_SECONDS) * 1000;
  }
}
