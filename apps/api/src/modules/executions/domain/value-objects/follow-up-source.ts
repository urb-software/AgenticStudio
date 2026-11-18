export const FOLLOW_UP_SOURCES = [
  'pull_request_checks',
  'bring_up_to_date',
  'review_comments',
] as const;
export type FollowUpSource = (typeof FOLLOW_UP_SOURCES)[number];
