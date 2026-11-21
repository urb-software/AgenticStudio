import type { MergeApproval } from '../entities/merge-approval.js';

export const MERGE_APPROVAL_REPOSITORY = Symbol('MERGE_APPROVAL_REPOSITORY');

/** Every approval of a Run is kept; at most one of them is pending. */
export interface MergeApprovalRepository {
  /** The newest approval of the Run, or `null` when the operator never approved a merge. */
  findLatest(runId: string): Promise<MergeApproval | null>;

  /**
   * Stores a new pending approval. `false`, with nothing stored, when the Run already has a
   * pending one: the store refuses a second, so two requests never merge the same Run.
   */
  add(approval: MergeApproval): Promise<boolean>;

  /** Replaces the stored approval with the same id: its outcome or its fetch. */
  save(approval: MergeApproval): Promise<void>;

  /**
   * Marks the Run's pending approvals older than `staleBefore` as not carried out (`interrupted`),
   * so a request that died cannot block the Run for good.
   */
  interruptStale(runId: string, staleBefore: Date, now: Date): Promise<void>;
}
