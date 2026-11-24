/** Why an operation failed; `controller_lost`, `not_claimed` and `report_overdue` are recorded by the API alone. Pinned to the protocol by a test. */
export const PREVIEW_FAILURE_CODES = [
  'validation_refused',
  'compose_file_missing',
  'source_unavailable',
  'archive_invalid',
  'environment_file_tracked',
  'disk_full',
  'egress_rules_missing',
  'limits_failed',
  'build_failed',
  'build_timed_out',
  'start_failed',
  'runtime_failed',
  'controller_stopped',
  'controller_lost',
  'not_claimed',
  'report_overdue',
  'controller_error',
] as const;
export type PreviewFailureCode = (typeof PREVIEW_FAILURE_CODES)[number];
