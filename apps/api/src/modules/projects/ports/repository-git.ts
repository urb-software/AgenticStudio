/**
 * Git port of the `projects` module: the only way a use case reaches a Repository or its
 * Clone (security.md §4, "Git adapter hardening baseline"). The adapter behind it runs the
 * system `git` binary on Linux only; nothing here depends on how.
 */

/** DI token for the {@link RepositoryGit} adapter. */
export const REPOSITORY_GIT = Symbol('REPOSITORY_GIT');

/** SSH material for one operation, supplied by the caller (never stored by the adapter). */
export interface SshCredentials {
  /** The Project's Deploy key: an OpenSSH private key, PEM-armoured. */
  privateKey: string;
  /** The only host key accepted for the remote: `<key-type> <base64>`, e.g. `ssh-ed25519 AAAA…`. */
  hostKey: string;
}

/** Per-operation options. */
export interface GitOperationOptions {
  /** Aborts the operation: the Git process tree is killed and the call rejects with an `AbortError`. */
  signal?: AbortSignal;
  /**
   * Time limit in milliseconds. It can only shorten the adapter's own limit for the
   * operation (10 minutes for a clone, 2 minutes otherwise, in production).
   */
  timeoutMs?: number;
  /** Required for `ssh` remotes; ignored otherwise. */
  ssh?: SshCredentials;
}

/** What the Repository says about itself. */
export interface RemoteInspection {
  /** The remote's default branch (its `HEAD`), or `null` when it does not advertise one. */
  defaultBranch: string | null;
  /** Whether the requested branch exists on the remote. */
  branchExists: boolean;
}

/** The fixed failure reasons of a Git operation (Epic #55). */
export const GIT_FAILURE_REASONS = [
  'auth_failed',
  'host_unreachable',
  'host_key_mismatch',
  'repository_not_found',
  'branch_not_found',
  'timeout',
  'size_limit',
  'unknown',
] as const;

export type GitFailureReason = (typeof GIT_FAILURE_REASONS)[number];

/**
 * Operations on one project are serialized by the adapter (in-process lock: one API
 * process owns the data directory). Errors: {@link GitRequestRejectedError} before Git
 * starts, {@link GitUnsupportedPlatformError} off Linux, an `AbortError` on abort, and
 * {@link GitOperationError} for everything else, unexpected failures as `unknown`. If the
 * API process crashes mid-operation, the Git process it started is orphaned until it ends
 * on its own; start-up removes the stale temporary files and partial Clones.
 */
export interface RepositoryGit {
  /**
   * Throws {@link GitUnsupportedPlatformError} when Git operations cannot run on this host
   * (anything but Linux), so a caller can refuse a request before scheduling any work.
   */
  assertSupported(): void;

  /** Checks that the remote answers; reports whether `branch` exists and its default branch. */
  inspectRemote(
    remoteUrl: string,
    branch: string,
    options?: GitOperationOptions,
  ): Promise<RemoteInspection>;

  /**
   * Creates the Project's bare Clone with `branch` from the remote; returns the branch's
   * commit id. A failed or aborted clone leaves no partial Clone behind.
   */
  clone(
    projectId: string,
    remoteUrl: string,
    branch: string,
    options?: GitOperationOptions,
  ): Promise<{ commit: string }>;

  /** Brings `branch` of the existing Clone up to date with the remote; returns its commit id. */
  fetch(
    projectId: string,
    remoteUrl: string,
    branch: string,
    options?: GitOperationOptions,
  ): Promise<{ commit: string }>;

  /** The commit id of `branch` in the Project's Clone. */
  readBranchCommit(
    projectId: string,
    branch: string,
    options?: GitOperationOptions,
  ): Promise<{ commit: string }>;

  /** Removes the Project's Clone (and any partial one); a missing Clone is not an error. */
  removeClone(projectId: string, options?: GitOperationOptions): Promise<void>;
}

/** A Git operation failed; `reason` is one of the fixed codes, `detail` is redacted Git output. */
export class GitOperationError extends Error {
  constructor(
    readonly reason: GitFailureReason,
    readonly detail: string = '',
  ) {
    super(`Git operation failed: ${reason}`);
    this.name = 'GitOperationError';
  }
}

/**
 * The request was refused before Git started: a disallowed or malformed remote URL, an
 * invalid branch name or project id, missing SSH credentials, a missing or existing Clone.
 */
export class GitRequestRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitRequestRejectedError';
  }
}

/**
 * The operation needs the Project's Clone, and there is none on disk (a fetch or a read of
 * a Clone that was removed, or never made). A {@link GitRequestRejectedError}.
 */
export class GitCloneMissingError extends GitRequestRejectedError {
  constructor() {
    super('The project has no Clone.');
    this.name = 'GitCloneMissingError';
  }
}

/** Repository features run on Linux only (security.md §4). */
export class GitUnsupportedPlatformError extends Error {
  constructor(readonly platform: string) {
    super(`Repository features are not supported on this platform (${platform}); they need Linux.`);
    this.name = 'GitUnsupportedPlatformError';
  }
}
