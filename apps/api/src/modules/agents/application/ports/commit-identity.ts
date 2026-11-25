export const DEFINITIONS_COMMIT_IDENTITY = Symbol('DEFINITIONS_COMMIT_IDENTITY');

/** Author and committer of a publish commit. */
export interface CommitIdentity {
  name: string;
  email: string;
}

/** Where the identity comes from: Studio's settings, never a request. */
export interface CommitIdentitySource {
  /** `null` while the settings are not set. */
  get(): CommitIdentity | null;
}
