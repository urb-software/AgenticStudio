import type { PreviewBuildOutput } from '../../../../platform/api';

type FailureCode = NonNullable<PreviewBuildOutput['failure']>['code'];

/**
 * One fixed sentence per failure code. The record is exhaustive, so a code the API adds does not
 * compile until it has wording. The controller's detail is shown beside it, as plain text.
 */
export const FAILURE_MESSAGE: Record<FailureCode, string> = {
  validation_refused: 'The Compose file was refused, so nothing was built.',
  compose_file_missing: 'The Compose file is not in the repository at this commit.',
  source_unavailable: 'The controller could not get the source for this commit.',
  archive_invalid: 'The source archive was not accepted.',
  environment_file_tracked:
    'The Environment file is tracked in the repository, so the build was refused.',
  disk_full: 'The environment server ran out of disk space.',
  egress_rules_missing: 'The network rules for builds are not in place on the environment server.',
  limits_failed: 'The memory and CPU limits for the build could not be set.',
  build_failed: 'The build did not succeed.',
  build_timed_out: 'The build ran past its time limit and was stopped.',
  start_failed: 'The stack was built but did not start.',
  runtime_failed: 'The stack started but did not stay up.',
  controller_stopped: 'The environment controller stopped while the build was running.',
  controller_error: 'The environment controller hit an error.',
  controller_lost:
    'The environment controller stopped reporting while it held the build, so Studio gave the build up.',
  not_claimed:
    'No environment controller picked up the build in time. Check that the controller is running.',
  report_overdue: 'The controller held the build for longer than its time limit allows.',
};

export const PREVIEW_REMOVED_MESSAGE = 'The new build could not start, so the Preview was stopped.';
