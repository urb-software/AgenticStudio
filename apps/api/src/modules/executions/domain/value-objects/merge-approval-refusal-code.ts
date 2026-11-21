import type { MergeRefusal } from './merge-refusal.js';

/** A stored refusal also says when a request ended before it recorded a result. */
export const MERGE_APPROVAL_REFUSAL_CODES = [
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
  'interrupted',
] as const satisfies readonly (MergeRefusal | 'interrupted')[];
export type MergeApprovalRefusalCode = (typeof MERGE_APPROVAL_REFUSAL_CODES)[number];
