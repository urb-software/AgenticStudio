/**
 * How long an approval may stay pending. The merge runs inside one request, so an older pending
 * approval belongs to a request that died: it reads as interrupted.
 */
export class MergeApprovalLease {
  static readonly SECONDS = 120;

  private constructor(readonly staleBefore: Date) {}

  static at(now: Date): MergeApprovalLease {
    return new MergeApprovalLease(new Date(now.getTime() - MergeApprovalLease.SECONDS * 1000));
  }

  isOver(approvedAt: Date): boolean {
    return approvedAt.getTime() < this.staleBefore.getTime();
  }
}
