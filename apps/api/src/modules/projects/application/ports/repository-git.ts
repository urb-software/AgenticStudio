/** Git port: the only way a use case reaches a Repository or its Clone (security.md §4). */

import {
  REPOSITORY_FAILURE_CODES,
  type RepositoryFailureCode,
} from '../../domain/value-objects/repository-failure.js';

export const REPOSITORY_GIT = Symbol('REPOSITORY_GIT');

/** SSH material for one operation, supplied by the caller (never stored by the adapter). */
export interface SshCredentials {
  privateKey: string;
  /**
   * The only host keys accepted for the remote (at least one): `<key-type> <base64>`, e.g.
   * `ssh-ed25519 AAAA…`. A host may have several (one per key type), all trusted alike.
   */
  hostKeys: readonly string[];
}

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

export interface RemoteInspection {
  /** The remote's default branch (its `HEAD`), or `null` when it does not advertise one. */
  defaultBranch: string | null;
  branchExists: boolean;
}

export type GitFailureReason = Exclude<RepositoryFailureCode, 'interrupted'>;

export const GIT_FAILURE_REASONS: readonly GitFailureReason[] = REPOSITORY_FAILURE_CODES.filter(
  (code): code is GitFailureReason => code !== 'interrupted',
);

/**
 * Operations on one project are serialized by the adapter (in-process lock). Errors:
 * {@link GitRequestRejectedError} before Git starts, {@link GitUnsupportedPlatformError} off
 * Linux, `AbortError` on abort, {@link GitOperationError} otherwise (`unknown` if unexpected).
 */
export interface RepositoryGit {
  /**
   * Throws {@link GitUnsupportedPlatformError} when Git operations cannot run on this host
   * (anything but Linux), so a caller can refuse a request before scheduling any work.
   */
  assertSupported(): void;

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

  /**
   * Retrieves the host key an `ssh` remote presents (`<key-type> <base64>`; ed25519, ECDSA,
   * then RSA). Nothing is trusted or stored: the operator confirms its fingerprint. Fails with
   * `host_unreachable` (or `timeout`) when the host presents no usable key.
   */
  scanHostKey(remoteUrl: string, options?: GitOperationOptions): Promise<{ hostKey: string }>;

  fetch(
    projectId: string,
    remoteUrl: string,
    branch: string,
    options?: GitOperationOptions,
  ): Promise<{ commit: string }>;

  readBranchCommit(
    projectId: string,
    branch: string,
    options?: GitOperationOptions,
  ): Promise<{ commit: string }>;

  /**
   * Whether the validated relative POSIX `path` is tracked at `commit` in the Project's Clone.
   * Throws {@link GitCloneMissingError} when there is no Clone, {@link GitRequestRejectedError}
   * for a malformed commit id or path.
   */
  isPathTracked(
    projectId: string,
    commit: string,
    path: string,
    options?: GitOperationOptions,
  ): Promise<boolean>;

  /** Removes the Project's Clone (and any partial one); a missing Clone is not an error. */
  removeClone(projectId: string, options?: GitOperationOptions): Promise<void>;
}

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
