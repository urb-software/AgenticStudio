const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidReviewedRunBranchError extends Error {
  constructor() {
    super('The branch is not the Run’s own agent branch.');
    this.name = 'InvalidReviewedRunBranchError';
  }
}

/**
 * The branch of a Run's review: `agent/<slug>-r<first 8 hex digits of the Run id>` and nothing
 * else, so a review can never fetch another Run's branch or the Integration branch.
 */
export class ReviewedRunBranch {
  private constructor(
    readonly runId: string,
    readonly name: string,
  ) {}

  /** Throws {@link InvalidReviewedRunBranchError}. */
  static of(runId: string, name: string): ReviewedRunBranch {
    if (!UUID.test(runId)) throw new InvalidReviewedRunBranchError();
    const id8 = runId.toLowerCase().slice(0, 8);
    if (!new RegExp(`^agent/[a-z0-9]+(?:-[a-z0-9]+)*-r${id8}$`).test(name)) {
      throw new InvalidReviewedRunBranchError();
    }
    return new ReviewedRunBranch(runId.toLowerCase(), name);
  }

  /** Where a review fetch puts the branch; never a branch the Clone checks out. */
  get reviewRef(): string {
    return `refs/studio/review/${this.runId}`;
  }
}
