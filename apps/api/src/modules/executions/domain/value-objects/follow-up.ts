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

/**
 * Why a Run cannot take a Follow-up now (Issue #141): it is not finished (queued, preparing,
 * running, waiting for the operator, or its delivery is being retried), a Follow-up is already
 * queued, its Working copy was removed (or it never reported one), it has no agent session, it
 * reached its Run step total, its Provider is unavailable, or the agent worker that holds its
 * Working copy is not connected. Issue #142: or its pull request, as last read, was merged or
 * closed, or was not found (`pull_request_missing`: gone, or not visible to the Agent account); a pull request
 * of unknown state does not stop it.
 */
export const FOLLOW_UP_REFUSALS = [
  'not_finished',
  'follow_up_queued',
  'pull_request_merged',
  'pull_request_closed',
  'pull_request_missing',
  'working_copy_removed',
  'no_session',
  'step_total_reached',
  'provider_unavailable',
  'worker_unavailable',
] as const;
export type FollowUpRefusal = (typeof FOLLOW_UP_REFUSALS)[number];

export type FollowUpEligibility = { allowed: true } | { allowed: false; reason: FollowUpRefusal };
