/**
 * The states of a Repository: the last operation, not whether a Clone exists (see
 * `RepositoryConnection.hasClone`). An SSH Repository starts in `awaiting_key`: its Deploy key
 * still has to be added on the Git host, then verified (Issue #62); `awaiting_host_key`: the
 * Git host is not trusted yet and the operator has to confirm its host key. `connecting`: the first Clone is being made; `ready`: the
 * Clone is up to date as of the last fetch; `fetching`: the Clone is being brought up to date;
 * `failed`: the last connect or fetch failed; `disconnecting`: the operator disconnected it and
 * its data is still being removed (the record goes last). Later stories add states.
 */
export const REPOSITORY_STATES = [
  'awaiting_key',
  'awaiting_host_key',
  'connecting',
  'ready',
  'fetching',
  'failed',
  'disconnecting',
] as const;
export type RepositoryState = (typeof REPOSITORY_STATES)[number];

/**
 * Why a Repository is `failed`: the fixed reason codes of Epic #55, the one list of the API.
 * The Git port's failure reasons are these codes, the HTTP contract's enum and the database's
 * CHECK constraint are pinned to them.
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
export interface RepositoryConnection {
  projectId: string;
  /** The URL as the operator entered it (trimmed). */
  url: string;
  integrationBranch: string;
  state: RepositoryState;
  /**
   * Whether a usable Clone exists: always when `ready` or `fetching`; when `failed`, only if
   * the failure was a fetch that kept the Clone. Never while `connecting` or `disconnecting`.
   */
  hasClone: boolean;
  /** Commit id of the Integration branch in the Clone; set exactly when `hasClone`. */
  headSha: string | null;
  /** When the Clone was last brought up to date; set exactly when `hasClone`. */
  lastFetchedAt: Date | null;
  /** Set exactly when `failed`. */
  failure: RepositoryFailure | null;
  /**
   * SSH Repositories only (Issue #62): the public half of the project's Deploy key, one
   * OpenSSH line (`ssh-ed25519 AAAA… studio-<project>`); set exactly when `deployKeySecret` is.
   */
  publicKey: string | null;
  /**
   * The secret store's reference to the Deploy key's private half; never the key itself.
   * Set exactly for an SSH Repository (until a Disconnect removes it).
   */
  deployKeySecret: string | null;
  /** The host key the operator confirmed, pinned for this Repository: `<type> <base64>`. */
  pinnedHostKey: string | null;
  /** The retrieved host key awaiting the operator's confirmation; set exactly when `awaiting_host_key`. */
  pendingHostKey: string | null;
  /**
   * SHA256 fingerprint of `pendingHostKey` when awaiting confirmation, otherwise of
   * `pinnedHostKey`; `null` when there is neither.
   */
  hostKeyFingerprint: string | null;
}

/**
 * Whether "Verify and clone" applies (Issue #62): an SSH Repository (it has a Deploy key)
 * without a Clone that is `awaiting_key`, `awaiting_host_key`, or `failed` (Retry keeps the
 * Deploy key).
 */
export function isVerifiable(repository: RepositoryConnection): boolean {
  return (
    repository.deployKeySecret !== null &&
    !repository.hasClone &&
    (repository.state === 'awaiting_key' ||
      repository.state === 'awaiting_host_key' ||
      repository.state === 'failed')
  );
}

/** Studio's own explanation of a `host_key_mismatch`, first in the failure detail (Issue #62). */
export const HOST_KEY_CHANGED_DETAIL =
  "The Git host's key changed. Studio never accepts a changed host key on its own: if the " +
  'change is expected, disconnect the repository and connect it again.';

/**
 * The failure of a Git operation: `host_key_mismatch` gets Studio's explanation first, then
 * the redacted Git output; every other reason keeps the Git output as it is.
 */
export function gitOperationFailure(
  code: RepositoryFailureCode,
  gitOutput = '',
): RepositoryFailure {
  if (code !== 'host_key_mismatch') return repositoryFailure(code, gitOutput);
  return repositoryFailure(
    code,
    gitOutput ? `${HOST_KEY_CHANGED_DETAIL}\n\n${gitOutput}` : HOST_KEY_CHANGED_DETAIL,
  );
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
