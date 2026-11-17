/** The owner label of Run snapshots in the secret store (ADR 0001, Issue #76). */
export const RUN_ENVIRONMENT_FILE_SECRET_OWNER = 'executions.run-environment-file';

/**
 * How old an unreferenced snapshot must be before the sweep deletes it: far longer than a
 * claim takes between storing the snapshot and recording its reference on the Run.
 */
export const RUN_ENVIRONMENT_FILE_ORPHAN_AGE_MS = 60 * 60 * 1000;

/**
 * A Run's snapshot of its Project's Environment file (Issue #104): copied into a Run-scoped
 * secret when the Run is claimed, used for the Run's log redaction, and deleted once the Run
 * is final, except while its failed delivery can be retried (a retry still reports text that
 * needs redaction; coordinator decision on the review of #125). The Run itself records only
 * whether it was supplied one, and the file's path, which this class answers about.
 */
export class RunEnvironmentFile {
  private constructor(readonly path: string | null) {}

  /** The Environment file a Run was given at `path`, or none (`null`). */
  static at(path: string | null): RunEnvironmentFile {
    return new RunEnvironmentFile(path);
  }

  /**
   * Whether a diff file's path is this Environment file's path (review L-3 of #149): compared
   * without a leading `./` or `/`, so another spelling of the same path is caught too.
   */
  covers(filePath: string): boolean {
    if (this.path === null) return false;
    const normalise = (value: string) => value.replace(/^(?:\.\/|\/)+/, '');
    return normalise(filePath) === normalise(this.path);
  }
}
