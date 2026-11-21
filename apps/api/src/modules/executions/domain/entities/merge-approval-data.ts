import type {
  MergeApprovalRefusalCode,
  MergeApprovalResult,
  MergeCheckSeen,
  MergeMethod,
} from '@agentic-studio/contracts';

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
  readonly cloneFetchStartedAt: Date | null;
}
