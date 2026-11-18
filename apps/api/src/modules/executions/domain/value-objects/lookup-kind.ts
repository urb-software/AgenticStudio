/**
 * Studio itself never reads the Git host: only an agent worker can answer, through the Agent
 * account. The worker protocol's lists are pinned to these by a test.
 */
export const LOOKUP_KINDS = [
  'pull_request_state',
  'failing_check_logs',
  'review_comments',
] as const;
export type LookupKind = (typeof LOOKUP_KINDS)[number];
