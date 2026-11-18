import type { StoredRepositoryConnection } from './repository-connection-data.js';

export interface ConnectAttempt {
  projectId: string;
  url: string;
  /** The remote's identity (`RemoteIdentity`); unique across Projects. */
  identity: string;
  integrationBranch: string;
  /**
   * SSH only: the project's Deploy key. With it the Repository is stored `awaiting_key`, without it
   * `connecting`.
   */
  deployKey?: { publicKey: string; secretRef: string } | null;
  /** SSH only: a host key already confirmed for this host, kept across a Retry. */
  pinnedHostKey?: string | null;
  /**
   * True when `deployKey` is the failed Repository's own key, kept by a Retry. The Retry then applies
   * only while the Repository still references it: a key released by a concurrent Connect or
   * Disconnect may already be deleted.
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
