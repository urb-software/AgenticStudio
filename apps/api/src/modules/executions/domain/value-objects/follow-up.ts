export const FOLLOW_UP_SOURCES = [
  'pull_request_checks',
  'bring_up_to_date',
  'review_comments',
] as const;
export type FollowUpSource = (typeof FOLLOW_UP_SOURCES)[number];

export const FOLLOW_UP_MAX_LENGTH = 10_000;

export interface FollowUpComments {
  count: number;
  authors: string[];
}

/** `pull_request_missing`: gone, or not visible to the Agent account. */
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
