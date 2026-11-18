/**
 * Why a Repository is `failed`: the fixed reason codes, the one list of the API. The Git port's
 * reasons are these but `interrupted`; the HTTP enum and the database CHECK constraint match.
 */
export const REPOSITORY_FAILURE_CODES = [
  'auth_failed',
  'host_unreachable',
  'host_key_mismatch',
  'repository_not_found',
  'branch_not_found',
  'timeout',
  'size_limit',
  'remote_not_allowed',
  /** The remote answered with an HTTP redirect; Studio never follows one. */
  'redirect_refused',
  /**
   * The operation was cut off by a crash or a restart of Studio, not by the Repository; never a Git
   * failure reason.
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

export const FAILURE_DETAIL_MAX_LENGTH = 2000;

/**
 * Longest remote default branch a failure names (the column's size). A longer name could never be an
 * Integration branch, so it is left out, not cut.
 */
export const REMOTE_DEFAULT_BRANCH_MAX_LENGTH = 255;

/**
 * The detail of an `unknown` failure that has nothing else to show: fixed text, never the error
 * itself, whose redacted form goes to the API log only.
 */
export const UNEXPECTED_FAILURE_DETAIL =
  'Studio stopped because of an unexpected error. The Studio API log has the details.';

/**
 * The detail of an `unknown` Git failure whose redacted output is empty: Git or ssh-keyscan failed
 * without saying why. The Git adapter logs every failed run.
 */
export const GIT_FAILURE_WITHOUT_OUTPUT_DETAIL =
  'Git failed without an explanation. The Studio API log has the details.';

export const HOST_KEY_CHANGED_DETAIL =
  "The Git host's key changed. Studio never accepts a changed host key on its own: if the " +
  'change is expected, disconnect the repository and connect it again.';

export const NO_TRUSTED_HOST_KEY_DETAIL =
  "Studio trusts no host key for this Git host. If the host's key changed as expected, " +
  'disconnect the repository and connect it again.';

export const NOT_STARTED_DETAIL = 'The clone could not be started. Try again.';

/**
 * The failure a Repository records: a reason code, a detail (redacted Git output or a short fixed
 * explanation, never a secret) and, for `branch_not_found`, the remote's default branch. Built only
 * through its factories.
 */
export class RepositoryFailure {
  private constructor(
    readonly code: RepositoryFailureCode,
    /** Redacted Git output or a short fixed explanation; never a secret. */
    readonly detail: string,
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

  static noTrustedHostKey(): RepositoryFailure {
    return RepositoryFailure.of('host_key_mismatch', NO_TRUSTED_HOST_KEY_DETAIL);
  }

  static interrupted(): RepositoryFailure {
    return RepositoryFailure.of('interrupted');
  }

  static unexpected(): RepositoryFailure {
    return RepositoryFailure.of('unknown', UNEXPECTED_FAILURE_DETAIL);
  }

  static notStarted(): RepositoryFailure {
    return RepositoryFailure.of('unknown', NOT_STARTED_DETAIL);
  }

  static fromUnfinishedJob(operation: 'clone' | 'fetch', job: UnfinishedJob): RepositoryFailure {
    switch (job.reason) {
      case 'timeout':
        return RepositoryFailure.of('timeout', `The ${operation} took too long and was stopped.`);
      case 'cancelled':
        return RepositoryFailure.of('unknown', 'Cancelled');
      // A crash-like end: the queue lost the job, or the API is shutting down.
      case 'stalled':
      case 'shutdown':
        return RepositoryFailure.interrupted();
      case 'error':
        return RepositoryFailure.unexpected();
    }
  }
}
