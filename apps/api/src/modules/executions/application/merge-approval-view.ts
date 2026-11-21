import type { MergeApproval } from '../domain/entities/merge-approval.js';

/** A Merge approval as the merge and the single Run answer show it. */
export interface MergeApprovalView {
  id: string;
  approvedAt: Date;
  approvedBy: 'operator';
  commit: string;
  integrationBranch: string;
  method: MergeApproval['method'];
  checksSeen: MergeApproval['checksSeen'];
  result: MergeApproval['result'];
  refusal: MergeApproval['refusal'];
  mergedCommit: string | null;
  completedAt: Date | null;
  cloneFetchStartedAt: Date | null;
}

export function mergeApprovalView(approval: MergeApproval): MergeApprovalView {
  return {
    id: approval.id,
    approvedAt: approval.approvedAt,
    approvedBy: approval.approvedBy,
    commit: approval.commit,
    integrationBranch: approval.integrationBranch,
    method: approval.method,
    checksSeen: approval.checksSeen,
    result: approval.result,
    refusal: approval.refusal === null ? null : { ...approval.refusal },
    mergedCommit: approval.mergedCommit,
    completedAt: approval.completedAt,
    cloneFetchStartedAt: approval.cloneFetchStartedAt,
  };
}
