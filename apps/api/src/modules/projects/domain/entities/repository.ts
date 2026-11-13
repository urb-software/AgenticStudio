/**
 * The states of a Repository. `connecting`: the first Clone is being made; `ready`: the
 * Clone exists; `failed`: the last attempt failed (no usable Clone). Later stories add states.
 */
export const REPOSITORY_STATES = ['connecting', 'ready', 'failed'] as const;
export type RepositoryState = (typeof REPOSITORY_STATES)[number];

/** Why a Repository is `failed`: the fixed reason codes of Epic #55. */
export const REPOSITORY_FAILURE_CODES = [
  'auth_failed',
  'host_unreachable',
  'host_key_mismatch',
  'repository_not_found',
  'branch_not_found',
  'timeout',
  'size_limit',
  'unknown',
] as const;
export type RepositoryFailureCode = (typeof REPOSITORY_FAILURE_CODES)[number];

/** The detail of a failure left by a crash or shutdown (Issue #60). */
export const INTERRUPTED_DETAIL = 'Interrupted';

/** Longest stored failure detail; longer redacted Git output is cut. */
export const FAILURE_DETAIL_MAX_LENGTH = 2000;

export interface RepositoryFailure {
  code: RepositoryFailureCode;
  /** Redacted Git output or a short fixed explanation; never a secret. */
  detail: string;
  /** The remote's default branch, known for `branch_not_found` when the remote advertises one. */
  remoteDefaultBranch: string | null;
}

/** The Repository connected to a Project (at most one per Project). */
export interface Repository {
  projectId: string;
  /** The URL as the operator entered it (trimmed). */
  url: string;
  integrationBranch: string;
  state: RepositoryState;
  /** Commit id of the Integration branch in the Clone; set when `ready`. */
  headSha: string | null;
  /** When the Clone was last brought up to date; set when `ready`. */
  lastFetchedAt: Date | null;
  /** Set exactly when `failed`. */
  failure: RepositoryFailure | null;
}

/** Builds a failure, cutting an over-long detail. */
export function repositoryFailure(
  code: RepositoryFailureCode,
  detail = '',
  remoteDefaultBranch: string | null = null,
): RepositoryFailure {
  const cut =
    detail.length > FAILURE_DETAIL_MAX_LENGTH
      ? `${detail.slice(0, FAILURE_DETAIL_MAX_LENGTH - 1)}…`
      : detail;
  return { code, detail: cut, remoteDefaultBranch };
}
