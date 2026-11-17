import type { ReviewComments } from '../../entities/review-comments.js';
import type { ReviewCommentsSnapshot } from '../../value-objects/review-comments-snapshot.js';
import type { ReviewCommentRepository } from '../review-comment-repository.js';
import type { InMemoryRunRepository } from './in-memory-run-repository.js';

/**
 * In-memory adapter of {@link ReviewCommentRepository} for handler tests: one loaded set per Run,
 * replaced by each load. The storage is the Run fake's `reviewSets` map, so a test can set up and
 * read it.
 */
export class InMemoryReviewCommentRepository implements ReviewCommentRepository {
  constructor(private readonly runs: InMemoryRunRepository) {}

  find(runId: string): Promise<ReviewComments | null> {
    return Promise.resolve(this.runs.reviewSets.get(runId) ?? null);
  }

  findSnapshot(runId: string): Promise<ReviewCommentsSnapshot | null> {
    return Promise.resolve(this.runs.reviewSets.get(runId)?.snapshot() ?? null);
  }

  replace(runId: string, comments: ReviewComments): Promise<void> {
    this.runs.reviewSets.set(runId, comments);
    return Promise.resolve();
  }

  discard(runId: string): Promise<void> {
    this.runs.reviewSets.delete(runId);
    return Promise.resolve();
  }
}
