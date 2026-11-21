import type {
  MergeApprovalRefusalCode,
  MergeApprovalResult,
  MergeCheckSeen,
  MergeMethod,
} from '@agentic-studio/contracts';
import { MergeApprovalLease } from '../value-objects/merge-approval-lease.js';
import type { MergeApprovalData } from './merge-approval-data.js';
import type { MergeApprovalFacts } from './merge-approval-facts.js';

/**
 * What the operator approved when pressing "Approve and merge": stored before the merge, kept
 * whatever came of it. A change returns the next approval.
 */
export class MergeApproval {
  static readonly REASON_MAX_LENGTH = 500;
  static readonly INTERRUPTED = 'The request ended before it recorded a result.';

  private constructor(
    readonly id: string,
    readonly runId: string,
    readonly approvedAt: Date,
    readonly approvedBy: 'operator',
    readonly commit: string,
    readonly integrationBranch: string,
    readonly method: MergeMethod,
    readonly checksSeen: readonly MergeCheckSeen[],
    readonly result: MergeApprovalResult,
    readonly refusal: { readonly code: MergeApprovalRefusalCode; readonly reason: string } | null,
    readonly mergedCommit: string | null,
    readonly completedAt: Date | null,
    readonly cloneFetchStartedAt: Date | null,
  ) {}

  /** A new approval, pending until the merge is carried out or refused. */
  static approve(facts: MergeApprovalFacts, now: Date): MergeApproval {
    return new MergeApproval(
      facts.id,
      facts.runId,
      now,
      'operator',
      facts.commit,
      facts.integrationBranch,
      facts.method,
      facts.checksSeen.map((check) => ({ name: check.name, state: check.state })),
      'pending',
      null,
      null,
      null,
      null,
    );
  }

  static restore(data: MergeApprovalData): MergeApproval {
    return new MergeApproval(
      data.id,
      data.runId,
      data.approvedAt,
      data.approvedBy,
      data.commit,
      data.integrationBranch,
      data.method,
      data.checksSeen,
      data.result,
      data.refusal,
      data.mergedCommit,
      data.completedAt,
      data.cloneFetchStartedAt,
    );
  }

  get isPending(): boolean {
    return this.result === 'pending';
  }

  get isCarriedOut(): boolean {
    return this.result === 'carried_out';
  }

  /** `reason` is the Git host's, redacted; it is cut to what is stored. */
  notCarriedOut(code: MergeApprovalRefusalCode, reason: string, now: Date): MergeApproval {
    return this.with({
      result: 'not_carried_out',
      refusal: { code, reason: reason.slice(0, MergeApproval.REASON_MAX_LENGTH) },
      completedAt: now,
    });
  }

  carriedOut(mergedCommit: string, now: Date): MergeApproval {
    return this.with({ result: 'carried_out', mergedCommit, completedAt: now });
  }

  /** The Clone fetch after the merge was handed to the Repository. */
  cloneFetchStarted(now: Date): MergeApproval {
    return this.with({ cloneFetchStartedAt: now });
  }

  /** What the page shows at `now`: a pending approval of a request that died reads as interrupted. */
  asOf(now: Date): MergeApproval {
    const stale = this.isPending && MergeApprovalLease.at(now).isOver(this.approvedAt);
    return stale ? this.notCarriedOut('interrupted', MergeApproval.INTERRUPTED, now) : this;
  }

  private with(patch: Partial<MergeApprovalData>): MergeApproval {
    return MergeApproval.restore({
      id: this.id,
      runId: this.runId,
      approvedAt: this.approvedAt,
      approvedBy: this.approvedBy,
      commit: this.commit,
      integrationBranch: this.integrationBranch,
      method: this.method,
      checksSeen: this.checksSeen,
      result: this.result,
      refusal: this.refusal,
      mergedCommit: this.mergedCommit,
      completedAt: this.completedAt,
      cloneFetchStartedAt: this.cloneFetchStartedAt,
      ...patch,
    });
  }
}
