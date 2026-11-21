import { mergeApprovalSchema, type MergeApproval } from '@agentic-studio/contracts';
import type { MergeApprovalView } from '../../../application/merge-approval-view.js';

/** The Merge approval as the single Run answer carries it. */
export const mergeApprovalResponseSchema = mergeApprovalSchema.meta({ id: 'MergeApproval' });

export function toMergeApprovalResponse(approval: MergeApprovalView): MergeApproval {
  return {
    id: approval.id,
    approvedAt: approval.approvedAt.toISOString(),
    approvedBy: approval.approvedBy,
    commit: approval.commit,
    integrationBranch: approval.integrationBranch,
    method: approval.method,
    checksSeen: approval.checksSeen.map((check) => ({ name: check.name, state: check.state })),
    result: approval.result,
    ...(approval.refusal === null ? {} : { refusal: approval.refusal }),
    ...(approval.mergedCommit === null ? {} : { mergedCommit: approval.mergedCommit }),
    ...(approval.mergeOutcomeUnknown ? { mergeOutcomeUnknown: true as const } : {}),
    ...(approval.completedAt === null ? {} : { completedAt: approval.completedAt.toISOString() }),
    ...(approval.cloneFetchStartedAt === null
      ? {}
      : { cloneFetchStartedAt: approval.cloneFetchStartedAt.toISOString() }),
  };
}
