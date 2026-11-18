/** The worker protocol's list is pinned to this one by a test. */
export const PULL_REQUEST_CHECK_STATES = [
  'queued',
  'running',
  'passed',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type PullRequestCheckState = (typeof PULL_REQUEST_CHECK_STATES)[number];
