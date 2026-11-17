import type { RepositoryFailure } from './repository-failure.js';
import type { RepositoryState } from './repository-state.js';

/** What a store keeps of a Repository: everything but the derived fields. */
export interface StoredRepositoryConnection {
  projectId: string;
  /** The URL as the operator entered it (trimmed). */
  url: string;
  integrationBranch: string;
  state: RepositoryState;
  /** Commit id of the Integration branch in the Clone; set exactly when a usable Clone exists. */
  headSha: string | null;
  /** When the Clone was last brought up to date; set exactly when `headSha` is. */
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
}

/**
 * A Repository's state as a plain record, with the fields derived from it: what the
 * `RepositoryConnection` class exposes and what crosses a boundary is mapped from.
 */
export interface RepositoryConnectionData extends StoredRepositoryConnection {
  /**
   * Whether a usable Clone exists: always when `ready` or `fetching`; when `failed`, only if
   * the failure was a fetch that kept the Clone. Never while `connecting` or `disconnecting`.
   */
  hasClone: boolean;
  /**
   * SHA256 fingerprint of `pendingHostKey` when awaiting confirmation, otherwise of
   * `pinnedHostKey`; `null` when there is neither. Derived, never stored (#72).
   */
  hostKeyFingerprint: string | null;
}

/**
 * A Repository's current values as read-only plain data: what a handler returns of it. It
 * carries the aggregate's own id (`projectId`: a Repository is identified by its Project) and,
 * as today, the Deploy key's secret reference, which the connect handler's tests read from the
 * result; the HTTP mapper (`toRepositoryResponse`) drops it, so no response shows it.
 */
export type RepositoryConnectionSnapshot = Readonly<RepositoryConnectionData>;
