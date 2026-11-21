import type { MergeCheckSeen, MergeMethod } from '@agentic-studio/contracts';

/** What a new Merge approval records of the moment the operator approved. */
export interface MergeApprovalFacts {
  readonly id: string;
  readonly runId: string;
  readonly commit: string;
  readonly integrationBranch: string;
  readonly method: MergeMethod;
  readonly checksSeen: readonly MergeCheckSeen[];
}
