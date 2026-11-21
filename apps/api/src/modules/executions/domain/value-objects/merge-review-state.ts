/** `none`: no review was requested. `out_of_date`: a ready review of a commit the Run branch left. */
export const MERGE_REVIEW_STATES = ['none', 'preparing', 'ready', 'failed', 'out_of_date'] as const;
export type MergeReviewState = (typeof MERGE_REVIEW_STATES)[number];

/** What a review's row holds; the rest are read from the clock and the Run. */
export const STORED_MERGE_REVIEW_STATES = ['preparing', 'ready', 'failed'] as const;
export type StoredMergeReviewState = (typeof STORED_MERGE_REVIEW_STATES)[number];
