export const CLOSE_REFUSALS = [
  'run_active',
  'pull_request_not_open',
  'merge_unavailable',
  'host_refused',
] as const;
export type CloseRefusal = (typeof CLOSE_REFUSALS)[number];
