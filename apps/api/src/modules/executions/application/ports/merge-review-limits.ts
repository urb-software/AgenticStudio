import type { MergeReviewLimitsFacts } from '../../domain/entities/run-merge-review-facts.js';

export const MERGE_REVIEW_LIMITS = Symbol('MERGE_REVIEW_LIMITS');

/** The limits a merge review is kept under: the Run diff's, so both reports are bounded alike. */
export type MergeReviewLimitsSetting = MergeReviewLimitsFacts;
