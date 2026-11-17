/**
 * Why a Repository is `failed`: the fixed reason codes of Epic #55, the one list of the API.
 * The Git port's failure reasons are these codes but `interrupted`; the HTTP contract's enum
 * and the database's CHECK constraint are pinned to them.
 */
export const REPOSITORY_FAILURE_CODES = [
  'auth_failed',
  'host_unreachable',
  'host_key_mismatch',
  'repository_not_found',
  'branch_not_found',
  'timeout',
  'size_limit',
  /** The remote host is, or resolves to, an address the policy refuses (Issue #69). */
  'remote_not_allowed',
  /** The remote answered with an HTTP redirect; Studio never follows one (Issue #69). */
  'redirect_refused',
  /**
   * The operation was cut off by a crash or a restart of Studio, not by the Repository (#72);
   * never a Git failure reason.
   */
  'interrupted',
  'unknown',
] as const;
export type RepositoryFailureCode = (typeof REPOSITORY_FAILURE_CODES)[number];

/**
 * Why the job of a clone or fetch ended without finishing on its own: the processor's own
 * error, or the reason the queue aborted it. It has the shape of the queue's failure report,
 * which the job's entry point passes on; the domain and the application name no queue.
 */
export type UnfinishedJob =
  | { reason: 'error'; error: unknown }
  | { reason: 'cancelled' | 'timeout' | 'stalled' | 'shutdown' };

/** Longest stored failure detail; longer redacted Git output is cut. */
export const FAILURE_DETAIL_MAX_LENGTH = 2000;

/**
 * Longest remote default branch a failure names (the column's size). A longer name could
 * never be an Integration branch (255 characters at most), so it is left out, not cut (#72).
 */
export const REMOTE_DEFAULT_BRANCH_MAX_LENGTH = 255;

/**
 * The detail of an `unknown` failure that has nothing else to show (#72): fixed text, never
 * the error itself, whose redacted form goes to the API log only.
 */
export const UNEXPECTED_FAILURE_DETAIL =
  'Studio stopped because of an unexpected error. The Studio API log has the details.';

/**
 * The detail of an `unknown` Git failure whose redacted output is empty (#72): Git or
 * ssh-keyscan failed without saying why. The Git adapter logs every failed run.
 */
export const GIT_FAILURE_WITHOUT_OUTPUT_DETAIL =
  'Git failed without an explanation. The Studio API log has the details.';

/** Studio's own explanation of a `host_key_mismatch`, first in the failure detail (Issue #62). */
export const HOST_KEY_CHANGED_DETAIL =
  "The Git host's key changed. Studio never accepts a changed host key on its own: if the " +
  'change is expected, disconnect the repository and connect it again.';

/** Stored as the failure detail when no host key is trusted for an SSH operation (Issue #62). */
export const NO_TRUSTED_HOST_KEY_DETAIL =
  "Studio trusts no host key for this Git host. If the host's key changed as expected, " +
  'disconnect the repository and connect it again.';

/** Stored on the Repository when the clone could not be scheduled after it was stored. */
export const NOT_STARTED_DETAIL = 'The clone could not be started. Try again.';

/**
 * The failure a Repository records (what a `failed` Repository shows): a reason code, a detail
 * that is redacted Git output or a short fixed explanation (never a secret) and, for
 * `branch_not_found`, the remote's default branch. It is built only through its factories,
 * which hold the rules of how a Git failure, a crash or a job that did not finish becomes one.
 */
export class RepositoryFailure {
  private constructor(
    readonly code: RepositoryFailureCode,
    /** Redacted Git output or a short fixed explanation; never a secret. */
    readonly detail: string,
    /** The remote's default branch, known for `branch_not_found` when the remote advertises one. */
    readonly remoteDefaultBranch: string | null,
  ) {}

  /**
   * A failure with this code, cutting an over-long detail and leaving out an over-long default
   * branch ({@link REMOTE_DEFAULT_BRANCH_MAX_LENGTH}).
   */
  static of(
    code: RepositoryFailureCode,
    detail = '',
    remoteDefaultBranch: string | null = null,
  ): RepositoryFailure {
    const cut =
      detail.length > FAILURE_DETAIL_MAX_LENGTH
        ? `${detail.slice(0, FAILURE_DETAIL_MAX_LENGTH - 1)}…`
        : detail;
    const defaultBranch =
      remoteDefaultBranch !== null && remoteDefaultBranch.length <= REMOTE_DEFAULT_BRANCH_MAX_LENGTH
        ? remoteDefaultBranch
        : null;
    return new RepositoryFailure(code, cut, defaultBranch);
  }

  /**
   * The failure of a Git operation: `host_key_mismatch` gets Studio's explanation first, then
   * the redacted Git output; `unknown` without output gets a fixed detail saying so; every other
   * reason keeps the Git output as it is.
   */
  static fromGit(code: RepositoryFailureCode, gitOutput = ''): RepositoryFailure {
    if (code === 'unknown' && !gitOutput) {
      return RepositoryFailure.of('unknown', GIT_FAILURE_WITHOUT_OUTPUT_DETAIL);
    }
    if (code !== 'host_key_mismatch') return RepositoryFailure.of(code, gitOutput);
    return RepositoryFailure.of(
      code,
      gitOutput ? `${HOST_KEY_CHANGED_DETAIL}\n\n${gitOutput}` : HOST_KEY_CHANGED_DETAIL,
    );
  }

  /** No host key is trusted for the Git host: a `host_key_mismatch` before Git runs (Issue #62). */
  static noTrustedHostKey(): RepositoryFailure {
    return RepositoryFailure.of('host_key_mismatch', NO_TRUSTED_HOST_KEY_DETAIL);
  }

  /** The failure of an operation cut off by a crash or a shutdown (Issue #60): no detail. */
  static interrupted(): RepositoryFailure {
    return RepositoryFailure.of('interrupted');
  }

  /** The failure of Studio's own unexpected error: `unknown` with the generic detail. */
  static unexpected(): RepositoryFailure {
    return RepositoryFailure.of('unknown', UNEXPECTED_FAILURE_DETAIL);
  }

  /** The clone could not be scheduled after the Repository was stored. */
  static notStarted(): RepositoryFailure {
    return RepositoryFailure.of('unknown', NOT_STARTED_DETAIL);
  }

  /** The failure stored for a clone or fetch whose job did not finish on its own. */
  static fromUnfinishedJob(operation: 'clone' | 'fetch', job: UnfinishedJob): RepositoryFailure {
    switch (job.reason) {
      case 'timeout':
        return RepositoryFailure.of('timeout', `The ${operation} took too long and was stopped.`);
      case 'cancelled':
        return RepositoryFailure.of('unknown', 'Cancelled');
      // A crash-like end: the queue lost the job, or the API is shutting down (#60 clarification 2).
      case 'stalled':
      case 'shutdown':
        return RepositoryFailure.interrupted();
      case 'error':
        return RepositoryFailure.unexpected();
    }
  }
}
