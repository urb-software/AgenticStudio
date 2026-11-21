export const MERGE_REFUSAL_CODES = [
  'checks_failing',
  'checks_running',
  'conflicting',
  'run_active',
  'commit_moved',
  'review_out_of_date',
  'pull_request_not_open',
  'merge_unavailable',
  'host_refused',
  'merge_in_progress',
] as const;
export type MergeRefusal = (typeof MERGE_REFUSAL_CODES)[number];
