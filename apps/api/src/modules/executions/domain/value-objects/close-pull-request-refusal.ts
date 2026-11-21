export const CLOSE_PULL_REQUEST_REFUSAL_CODES = [
  'run_active',
  'pull_request_not_open',
  'merge_unavailable',
  'host_refused',
] as const;
export type ClosePullRequestRefusal = (typeof CLOSE_PULL_REQUEST_REFUSAL_CODES)[number];
