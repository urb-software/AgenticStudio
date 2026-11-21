/**
 * Why no review can be requested: the Run has no pull request (or no known Run branch), its
 * pull request is merged, closed or missing, the Project's Repository is not ready, a review is
 * already being prepared, or the API does not run on Linux. A draft pull request is allowed.
 */
export const MERGE_REVIEW_REFUSALS = [
  'no_pull_request',
  'pull_request_not_open',
  'repository_not_ready',
  'review_in_progress',
  'unsupported_platform',
] as const;
export type MergeReviewRefusal = (typeof MERGE_REVIEW_REFUSALS)[number];
