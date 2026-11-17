/**
 * How a Run was delivered (Issue #102): `none` (succeeded, the Run branch had no new commits:
 * "No changes"), `delivered` (succeeded, with its draft pull request) or `failed` (the Run failed
 * with `delivery_failed`). `null` until then.
 */
export const RUN_DELIVERIES = ['none', 'delivered', 'failed'] as const;
export type RunDeliveryState = (typeof RUN_DELIVERIES)[number];

/** The draft pull request a delivery opened or reused. */
export interface RunPullRequest {
  url: string;
  number: number;
}

/**
 * What an agent worker reports about a successful delivery; `pushedCommit` (Issue #141) is the
 * commit the push left the remote Run branch at.
 */
export type RunDeliveryOutcome =
  /** `branchPushed`: only for a Run cancelled after its push, before a pull request (#124 review). */
  | { outcome: 'none'; branchPushed?: true; pushedCommit?: string }
  | { outcome: 'delivered'; pullRequest: RunPullRequest; pushedCommit?: string };

/** What a Run's delivery stores of it, by the names the Run is stored under. */
export interface RunDeliveryStored {
  /** The Repository's integration branch when the Run was started: its pull request's base. */
  integrationBranch: string;
  /** How the Run was delivered (Issue #102); `null` until it is. */
  delivery: RunDeliveryState | null;
  /** Set exactly when `delivery` is `delivered`. */
  pullRequest: RunPullRequest | null;
  /**
   * The operator asked to retry the failed delivery; it stays set while an agent worker holds
   * the Run for the retry (`claimedBy`), until the worker reports the outcome.
   */
  deliveryRequested: boolean;
  /** The commit the latest push left the remote Run branch at (Issue #141); `null` if none. */
  pushedCommit: string | null;
}

/**
 * The delivery of a Run (Issue #102): the integration branch its pull request is based on, how
 * it ended, the draft pull request it opened, the commit it pushed, and whether the operator
 * asked to retry it. A change returns a new delivery.
 */
export class RunDelivery {
  readonly integrationBranch: string;
  /** How the Run was delivered; `null` until it is. */
  readonly state: RunDeliveryState | null;
  readonly pullRequest: RunPullRequest | null;
  readonly pushedCommit: string | null;
  /** The operator asked to retry the failed delivery, and it is not over yet. */
  readonly requested: boolean;

  private constructor(stored: RunDeliveryStored) {
    this.integrationBranch = stored.integrationBranch;
    this.state = stored.delivery;
    this.pullRequest = stored.pullRequest;
    this.pushedCommit = stored.pushedCommit;
    this.requested = stored.deliveryRequested;
  }

  /** The delivery of a Run just started: nothing delivered, based on `integrationBranch`. */
  static start(integrationBranch: string): RunDelivery {
    return new RunDelivery({
      integrationBranch,
      delivery: null,
      pullRequest: null,
      deliveryRequested: false,
      pushedCommit: null,
    });
  }

  static restore(stored: RunDeliveryStored): RunDelivery {
    return new RunDelivery(stored);
  }

  /** The delivery with the stored fields in `patch` replaced (other keys are ignored). */
  with(patch: Partial<RunDeliveryStored>): RunDelivery {
    return new RunDelivery({ ...this.toStored(), ...patch });
  }

  toStored(): RunDeliveryStored {
    return {
      integrationBranch: this.integrationBranch,
      delivery: this.state,
      pullRequest: this.pullRequest,
      deliveryRequested: this.requested,
      pushedCommit: this.pushedCommit,
    };
  }

  /** Whether the Run has a draft pull request. */
  get hasPullRequest(): boolean {
    return this.pullRequest !== null;
  }

  /**
   * The stored fields a delivery outcome sets (Issue #102); an outcome without a pull request
   * keeps the Run's.
   */
  static outcomePatch(outcome: RunDeliveryOutcome): Partial<RunDeliveryStored> {
    return {
      delivery: outcome.outcome,
      ...(outcome.outcome === 'delivered' ? { pullRequest: { ...outcome.pullRequest } } : {}),
      ...(outcome.pushedCommit === undefined ? {} : { pushedCommit: outcome.pushedCommit }),
    };
  }
}
