/**
 * A Project's Environment file (Issue #104): one file of test settings that Studio places in
 * each Run's Working copy. The content lives in the secret store; the operator sees only what
 * is here. Test values only (security.md §3): the agent can read the file.
 */
export interface EnvironmentFileInfo {
  /** Relative POSIX path in the repository. */
  path: string;
  /** UTF-8 bytes of the content. */
  sizeBytes: number;
  /** When it was last set. */
  updatedAt: Date;
}

/** What the store holds: the visible fields and the secret store's reference to the content. */
export interface StoredEnvironmentFile extends EnvironmentFileInfo {
  secretRef: string;
}

/** The owner label of the content in the secret store (ADR 0001, Issue #76). */
export const ENVIRONMENT_FILE_SECRET_OWNER = 'projects.environment-file';

/** The path is not an acceptable Environment file path; `message` says why, for the operator. */
export class InvalidEnvironmentFilePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEnvironmentFilePathError';
  }
}

/** The path is tracked in the repository: writing the file would overwrite a tracked file. */
export class EnvironmentFilePathTrackedError extends InvalidEnvironmentFilePathError {
  constructor() {
    super(
      'This path is tracked in the repository at the current commit of the integration branch. ' +
        'Choose a path Git does not track, so no tracked file is overwritten.',
    );
    this.name = 'EnvironmentFilePathTrackedError';
  }
}

/** The content is not acceptable; `message` says why and never quotes the content. */
export class InvalidEnvironmentFileContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEnvironmentFileContentError';
  }
}
