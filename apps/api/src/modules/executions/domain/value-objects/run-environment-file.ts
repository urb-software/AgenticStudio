/**
 * Far longer than a claim takes between storing the snapshot and recording its
 * reference on the Run.
 */
export const RUN_ENVIRONMENT_FILE_ORPHAN_AGE_MS = 60 * 60 * 1000;

/**
 * Deleted once the Run is final, except while its failed delivery can be retried or it can resume
 * after the usage limit: both still report text that needs redaction.
 */
export class RunEnvironmentFile {
  private constructor(readonly path: string | null) {}

  static at(path: string | null): RunEnvironmentFile {
    return new RunEnvironmentFile(path);
  }

  /** Compared without a leading `./` or `/`, so another spelling of the same path is caught too. */
  covers(filePath: string): boolean {
    if (this.path === null) return false;
    const normalise = (value: string) => value.replace(/^(?:\.\/|\/)+/, '');
    return normalise(filePath) === normalise(this.path);
  }
}
