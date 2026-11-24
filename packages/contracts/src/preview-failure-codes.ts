/** The codes the environment controller may report for a failed operation. */
export const CONTROLLER_REPORTABLE_FAILURE_CODES = [
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
  'controller_error',
] as const;

/** The codes only the API sets: the controller cannot report them. */
export const API_ONLY_FAILURE_CODES = ['controller_lost', 'not_claimed', 'report_overdue'] as const;

/** Why an operation failed. Pinned to the API's domain list by a test. */
export const PREVIEW_OPERATION_FAILURE_CODES = [
  ...CONTROLLER_REPORTABLE_FAILURE_CODES,
  ...API_ONLY_FAILURE_CODES,
] as const;
