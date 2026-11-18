export const ENVIRONMENT_FILE_CONTENTS = Symbol('ENVIRONMENT_FILE_CONTENTS');

/**
 * Where Environment file contents are kept: the secret store, under the `projects.environment-file`
 * owner label. Nothing logs or returns a content except {@link read}.
 */
export interface EnvironmentFileContents {
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
