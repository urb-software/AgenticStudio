export const MERGE_SETTINGS = Symbol('MERGE_SETTINGS');

export interface MergeSettings {
  /** Whether the Merge credential is set. */
  configured: boolean;
  /** Test-only: a `file:///` fixture remote counts as a GitHub repository. */
  allowFileRemotes: boolean;
}
