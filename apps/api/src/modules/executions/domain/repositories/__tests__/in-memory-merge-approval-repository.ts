import { MergeApproval } from '../../entities/merge-approval.js';
import type { MergeApprovalRepository } from '../merge-approval-repository.js';

/** In-memory {@link MergeApprovalRepository} that refuses a second pending approval, as the store does. */
export class InMemoryMergeApprovalRepository implements MergeApprovalRepository {
  readonly approvals: MergeApproval[] = [];

  findLatest(runId: string): Promise<MergeApproval | null> {
    const own = this.approvals.filter((approval) => approval.runId === runId);
    const latest = own.reduce<MergeApproval | null>(
      (newest, approval) =>
        newest === null || approval.approvedAt.getTime() >= newest.approvedAt.getTime()
          ? approval
          : newest,
      null,
    );
    return Promise.resolve(latest);
  }

  add(approval: MergeApproval): Promise<boolean> {
    const taken = this.approvals.some(
      (stored) => stored.runId === approval.runId && stored.isPending,
    );
    if (taken) return Promise.resolve(false);
    this.approvals.push(approval);
    return Promise.resolve(true);
  }

  save(approval: MergeApproval): Promise<void> {
    const index = this.approvals.findIndex((stored) => stored.id === approval.id);
    if (index === -1) return Promise.reject(new Error('No such approval.'));
    this.approvals[index] = approval;
    return Promise.resolve();
  }

  interruptStale(runId: string, staleBefore: Date, now: Date): Promise<void> {
    this.approvals.forEach((stored, index) => {
      if (
        stored.runId === runId &&
        stored.isPending &&
        stored.approvedAt.getTime() < staleBefore.getTime()
      ) {
        this.approvals[index] = stored.notCarriedOut('interrupted', MergeApproval.INTERRUPTED, now);
      }
    });
    return Promise.resolve();
  }
}
