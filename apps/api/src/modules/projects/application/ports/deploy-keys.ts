import type { RepositoryConnection } from '../../domain/entities/repository-connection.js';
import type { TrustedHostKeys } from '../../domain/value-objects/trusted-host-keys.js';
import type { SshCredentials } from './repository-git.js';

export type DeployKeyHolder = Pick<
  RepositoryConnection,
  'url' | 'deployKeySecret' | 'pinnedHostKey'
>;

export const DEPLOY_KEYS = Symbol('DEPLOY_KEYS');

/** The secret store owner label of every Deploy key's private half; the orphan sweep lists by it. */
export const DEPLOY_KEY_SECRET_OWNER = 'projects.deploy-key';

export const DEPLOY_KEY_SWEEP_SETTINGS = Symbol('DEPLOY_KEY_SWEEP_SETTINGS');

export interface DeployKeySweepSettings {
  gracePeriodMs: number;
}

export interface StoredDeployKey {
  publicKey: string;
  secretRef: string;
}

/**
 * Where the Deploy keys of SSH Repositories are kept: the secret store (ADR 0001). The private
 * half is never returned except inside {@link SshCredentials}, and never logged.
 */
export interface DeployKeys {
  /** Generates a Deploy key for the project and stores its private half. */
  create(projectName: string): Promise<StoredDeployKey>;
  /**
   * The SSH material for one Git operation on the Repository, or `undefined` when it has no
   * Deploy key (HTTPS). Throws `NoTrustedHostKeyError` when no host key is trusted, and the
   * secret store's errors.
   */
  credentials(repository: DeployKeyHolder): Promise<SshCredentials | undefined>;
  trustedHostKeys(repository: DeployKeyHolder): TrustedHostKeys;
  /** Deletes the private half; a no-op when it is already gone. */
  remove(secretRef: string): Promise<void>;
  /**
   * The references of every stored Deploy key's private half at least `ageMs` old, by the
   * secret store's clock; never a key.
   */
  listOlderThan(ageMs: number): Promise<string[]>;
}
