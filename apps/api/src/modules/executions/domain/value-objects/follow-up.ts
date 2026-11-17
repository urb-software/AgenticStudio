/**
 * What a Follow-up was prepared from (Issue #145): the text came from the failing Pull request
 * checks, or (Issue #146) from the pull request's Review comments, which the operator reviewed
 * and may have edited; (Issue #147) `bring_up_to_date` is the request to merge the integration
 * branch into the Run branch. A Follow-up written from scratch has no source.
 */
export const FOLLOW_UP_SOURCES = [
  'pull_request_checks',
  'bring_up_to_date',
  'review_comments',
] as const;
export type FollowUpSource = (typeof FOLLOW_UP_SOURCES)[number];

/** Longest Follow-up, in characters (Issue #141). */
export const FOLLOW_UP_MAX_LENGTH = 10_000;

/** What a Follow-up prepared from Review comments records: how many, and their authors (Issue #146). */
export interface FollowUpComments {
  count: number;
  authors: string[];
}
