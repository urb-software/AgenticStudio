/** DI token of the {@link EnvironmentFileContents} port. */
export const ENVIRONMENT_FILE_CONTENTS = Symbol('ENVIRONMENT_FILE_CONTENTS');

/**
 * Where the projects' Environment file contents are kept (Issue #104): the secret store, under
 * the `projects.environment-file` owner label. A content is reached only by its reference;
 * nothing here logs or returns it except {@link read}.
 */
export interface EnvironmentFileContents {
  /** Stores a content; returns its reference. */
  store(content: string): Promise<string>;
  /** The content behind `reference`, or `null` when it is gone (deleted meanwhile). */
  read(reference: string): Promise<string | null>;
  /**
   * Deletes a content no project references any more. Never throws: a failure is logged by
   * reference only, and the orphan sweep deletes it later.
   */
  discard(reference: string): Promise<void>;
  /** The references of contents older than the orphan sweep's grace period (one hour). */
  listOld(): Promise<string[]>;
}
