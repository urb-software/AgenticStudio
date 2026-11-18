export const RUN_DELIVERIES = ['none', 'delivered', 'failed'] as const;
export type RunDeliveryState = (typeof RUN_DELIVERIES)[number];

export interface RunPullRequest {
  url: string;
  number: number;
}

export type RunDeliveryOutcome =
  /** `branchPushed`: only for a Run cancelled after its push, before a pull request. */
  | { outcome: 'none'; branchPushed?: true; pushedCommit?: string }
  | { outcome: 'delivered'; pullRequest: RunPullRequest; pushedCommit?: string };

export interface RunDeliveryStored {
  integrationBranch: string;
  delivery: RunDeliveryState | null;
  pullRequest: RunPullRequest | null;
  /**
   * Stays set while an agent worker holds the Run for the retry, until the worker reports the
   * outcome.
   */
  deliveryRequested: boolean;
  pushedCommit: string | null;
}

export class RunDelivery {
  readonly integrationBranch: string;
  readonly state: RunDeliveryState | null;
  readonly pullRequest: RunPullRequest | null;
  readonly pushedCommit: string | null;
  readonly requested: boolean;

  private constructor(stored: RunDeliveryStored) {
    this.integrationBranch = stored.integrationBranch;
    this.state = stored.delivery;
    this.pullRequest = stored.pullRequest;
    this.pushedCommit = stored.pushedCommit;
    this.requested = stored.deliveryRequested;
  }

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

  get hasPullRequest(): boolean {
    return this.pullRequest !== null;
  }

  /** An outcome without a pull request keeps the Run's. */
  static outcomePatch(outcome: RunDeliveryOutcome): Partial<RunDeliveryStored> {
    return {
      delivery: outcome.outcome,
      ...(outcome.outcome === 'delivered' ? { pullRequest: { ...outcome.pullRequest } } : {}),
      ...(outcome.pushedCommit === undefined ? {} : { pushedCommit: outcome.pushedCommit }),
    };
  }
}
