import type { StoredRepositoryConnection } from './repository-connection-data.js';

/** What a Connect (or a Retry) stores before the Clone is made. */
export interface ConnectAttempt {
  projectId: string;
  /** The URL as entered (trimmed). */
  url: string;
  /** The remote's identity (`RepositoryUrl.identityOf`); unique across Projects. */
  identity: string;
  integrationBranch: string;
  /**
   * SSH only (Issue #62): the project's Deploy key. With it the Repository is stored
   * `awaiting_key` (the operator adds the key on the Git host, then verifies); without it,
   * `connecting`.
   */
  deployKey?: { publicKey: string; secretRef: string } | null;
  /** SSH only: a host key already confirmed for this host, kept across a Retry. */
  pinnedHostKey?: string | null;
  /**
   * True when `deployKey` is the failed Repository's own key, kept by a Retry (Issue #76): the
   * Retry then applies only while the Repository still exists and references that key. A key a
   * concurrent Connect or Disconnect released may already be deleted, so it is never saved again.
   */
  keepsDeployKey?: boolean;
}

/**
 * What changed on a Repository since it was started or restored, for the store to save in one
 * step: the new values of the changed fields, the remote's identity when the change starts or
 * replaces the connection, and whether the record goes (the last step of a Disconnect).
 */
export interface RepositoryChanges {
  fields: Partial<StoredRepositoryConnection>;
  identity?: string;
  removed?: true;
}
