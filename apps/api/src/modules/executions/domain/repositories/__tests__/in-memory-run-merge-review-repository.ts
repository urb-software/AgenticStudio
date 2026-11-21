import type { RunMergeReview } from '../../entities/run-merge-review.js';
import type { RunMergeReviewRepository } from '../run-merge-review-repository.js';

/** In-memory {@link RunMergeReviewRepository} with the same conditional writes as the store. */
export class InMemoryRunMergeReviewRepository implements RunMergeReviewRepository {
  readonly reviews = new Map<string, RunMergeReview>();

  find(runId: string): Promise<RunMergeReview | null> {
    return Promise.resolve(this.reviews.get(runId) ?? null);
  }

  claim(review: RunMergeReview, staleBefore: Date): Promise<boolean> {
    const current = this.reviews.get(review.runId);
    const inProgress =
      current?.storedState === 'preparing' &&
      current.requestedAt.getTime() >= staleBefore.getTime();
    if (inProgress) return Promise.resolve(false);
    this.reviews.set(review.runId, review);
    return Promise.resolve(true);
  }

  finish(review: RunMergeReview): Promise<boolean> {
    const current = this.reviews.get(review.runId);
    if (
      current?.storedState !== 'preparing' ||
      current.requestedAt.getTime() !== review.requestedAt.getTime()
    ) {
      return Promise.resolve(false);
    }
    this.reviews.set(review.runId, review);
    return Promise.resolve(true);
  }
}
