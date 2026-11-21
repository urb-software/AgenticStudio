const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The two refs of a Run's review in the Project's Clone: where the Run branch and the
 * Integration branch land. Neither is a branch the Clone keeps or checks out.
 */
export class ReviewRefs {
  private constructor(
    readonly run: string,
    readonly base: string,
  ) {}

  /** Throws when `runId` is not a UUID, so no other text reaches a ref name. */
  static of(runId: string): ReviewRefs {
    if (!UUID.test(runId)) throw new TypeError('The Run id is not a UUID.');
    const id = runId.toLowerCase();
    return new ReviewRefs(`refs/studio/review/${id}`, `refs/studio/review-base/${id}`);
  }
}
