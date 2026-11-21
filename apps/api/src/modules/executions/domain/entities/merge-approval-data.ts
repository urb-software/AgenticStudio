import type { MergeApprovalRefusalCode } from '../value-objects/merge-approval-refusal-code.js';
import type { MergeApprovalResult } from '../value-objects/merge-approval-result.js';
import type { MergeCheckSeen } from '../value-objects/merge-check-seen.js';
import type { MergeMethod } from '../value-objects/merge-method.js';

/** What a Merge approval holds, to restore it from. */
export interface MergeApprovalData {
  readonly id: string;
  readonly runId: string;
  readonly approvedAt: Date;
  readonly approvedBy: 'operator';
  readonly commit: string;
  readonly integrationBranch: string;
  readonly method: MergeMethod;
  readonly checksSeen: readonly MergeCheckSeen[];
  readonly result: MergeApprovalResult;
  readonly refusal: { readonly code: MergeApprovalRefusalCode; readonly reason: string } | null;
  readonly mergedCommit: string | null;
  readonly completedAt: Date | null;
  readonly mergeRequestedAt: Date | null;
  readonly cloneFetchStartedAt: Date | null;
}
