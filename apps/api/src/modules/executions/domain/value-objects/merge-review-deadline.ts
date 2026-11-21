/**
 * How long a review may stay `preparing`. Preparation runs in the API process, so an older one
 * was lost with a restart: it reads as failed, and a new review can replace it.
 */
export class MergeReviewDeadline {
  static readonly PREPARING_MAX_MS = 15 * 60 * 1000;

  private constructor(readonly staleBefore: Date) {}

  static at(now: Date): MergeReviewDeadline {
    return new MergeReviewDeadline(new Date(now.getTime() - MergeReviewDeadline.PREPARING_MAX_MS));
  }

  isOver(requestedAt: Date): boolean {
    return requestedAt.getTime() < this.staleBefore.getTime();
  }
}
