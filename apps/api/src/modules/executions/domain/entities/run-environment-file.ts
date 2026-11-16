/**
 * A Run's snapshot of its Project's Environment file (Issue #104): copied into a Run-scoped
 * secret when the Run is claimed, used for the Run's log redaction, and deleted once the Run
 * is final, except while its failed delivery can be retried (a retry still reports text that
 * needs redaction; coordinator decision on the review of #125). The Run itself records only
 * whether it was supplied one, and the file's path.
 */

/**
 * Whether a final Run keeps its snapshot because it can still go on: `failed` with
 * `delivery_failed`, whose delivery can be retried (Issue #102), or with `usage_limit`, which
 * the operator can resume (Issue #105). Kept until the Run ends otherwise, its retry or resume
 * is given up (Working copy or worker gone), or the retention period ends.
 */
export function keepsSnapshotForRetry(run: {
  state: string;
  failure: { code: string } | null;
}): boolean {
  return (
    run.state === 'failed' &&
    (run.failure?.code === 'delivery_failed' || run.failure?.code === 'usage_limit')
  );
}

/** The owner label of Run snapshots in the secret store (ADR 0001, Issue #76). */
export const RUN_ENVIRONMENT_FILE_SECRET_OWNER = 'executions.run-environment-file';

/**
 * How old an unreferenced snapshot must be before the sweep deletes it: far longer than a
 * claim takes between storing the snapshot and recording its reference on the Run.
 */
export const RUN_ENVIRONMENT_FILE_ORPHAN_AGE_MS = 60 * 60 * 1000;
