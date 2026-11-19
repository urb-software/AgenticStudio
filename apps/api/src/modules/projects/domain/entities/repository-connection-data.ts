import type { RepositoryFailure } from '../value-objects/repository-failure.js';
import type { RepositoryState } from '../value-objects/repository-state.js';

/** What a Repository connection is restored from: the fields that storage holds. */
export interface RepositoryConnectionData {
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
