import type { RepositoryFailure } from '../value-objects/repository-failure.js';
import type { RepositoryState } from '../value-objects/repository-state.js';

export interface StoredRepositoryConnection {
  projectId: string;
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
   * SSH only: the public half of the project's Deploy key, one OpenSSH line; set exactly when
   * `deployKeySecret` is.
   */
  publicKey: string | null;
  /**
   * The secret store's reference to the Deploy key's private half; never the key itself.
   * Set exactly for an SSH Repository (until a Disconnect removes it).
   */
  deployKeySecret: string | null;
  pinnedHostKey: string | null;
  /** The retrieved host key awaiting the operator's confirmation; set exactly when `awaiting_host_key`. */
  pendingHostKey: string | null;
}

export interface RepositoryConnectionData extends StoredRepositoryConnection {
  /**
   * Whether a usable Clone exists: always when `ready` or `fetching`; when `failed`, only if
   * the failure was a fetch that kept the Clone. Never while `connecting` or `disconnecting`.
   */
  hasClone: boolean;
  /**
   * SHA256 fingerprint of `pendingHostKey` when awaiting confirmation, else of `pinnedHostKey`;
   * `null` when neither. Derived, never stored.
   */
  hostKeyFingerprint: string | null;
}
