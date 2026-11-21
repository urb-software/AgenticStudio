import type { MergeReviewRefusal } from '../value-objects/merge-review-refusal.js';

export class MergeReviewRefusedError extends Error {
  constructor(readonly reason: MergeReviewRefusal) {
    super(`A merge review cannot be requested now (${reason}).`);
    this.name = 'MergeReviewRefusedError';
  }
}

export class MergeReviewFileNotFoundError extends Error {
  constructor() {
    super('The merge review lists no file at this path.');
    this.name = 'MergeReviewFileNotFoundError';
  }
}
