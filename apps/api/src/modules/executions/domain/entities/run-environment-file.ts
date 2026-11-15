/**
 * A Run's snapshot of its Project's Environment file (Issue #104): copied into a Run-scoped
 * secret when the Run is claimed, used for the Run's log redaction, and deleted once the Run
 * is final. The Run itself records only whether it was supplied one.
 */

/** The owner label of Run snapshots in the secret store (ADR 0001, Issue #76). */
export const RUN_ENVIRONMENT_FILE_SECRET_OWNER = 'executions.run-environment-file';

/**
 * How old an unreferenced snapshot must be before the sweep deletes it: far longer than a
 * claim takes between storing the snapshot and recording its reference on the Run.
 */
export const RUN_ENVIRONMENT_FILE_ORPHAN_AGE_MS = 60 * 60 * 1000;
