import type { RepositoryConnection } from '../../domain/entities/repository.js';
import type { TrustedHostKeys } from '../../domain/value-objects/trusted-host-keys.js';
import type { SshCredentials } from './repository-git.js';

/** DI token of the {@link DeployKeys} port. */
export const DEPLOY_KEYS = Symbol('DEPLOY_KEYS');

/**
 * The secret store owner label of every Deploy key's private half (Issue #76): what the orphan
 * sweep lists, and nothing else.
 */
export const DEPLOY_KEY_SECRET_OWNER = 'projects.deploy-key';

/** DI token for {@link DeployKeySweepSettings}. */
export const DEPLOY_KEY_SWEEP_SETTINGS = Symbol('DEPLOY_KEY_SWEEP_SETTINGS');

export interface DeployKeySweepSettings {
  /** `DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS` in production; tests may pass a shorter one. */
  gracePeriodMs: number;
}

/** A stored Deploy key: the public half and the secret store's reference to the private half. */
export interface StoredDeployKey {
  publicKey: string;
  secretRef: string;
}

/**
 * Where the Deploy keys of SSH Repositories are kept (Issues #62, #76): the secret store
 * (ADR 0001). The private half is created and stored here, read here for one Git operation at
 * a time (the Git adapter writes it owner-only for that operation and deletes it), and deleted
 * here. It is never returned except inside {@link SshCredentials}, and never logged.
 */
export interface DeployKeys {
  /** Generates an ed25519 Deploy key commented `studio-<project name>` and stores its private half. */
  create(projectName: string): Promise<StoredDeployKey>;
  /**
   * The SSH material for one Git operation on the Repository, or `undefined` when it has no
   * Deploy key (HTTPS). Throws `NoTrustedHostKeyError` when no host key is trusted, and the
   * secret store's errors.
   */
  credentials(repository: RepositoryConnection): Promise<SshCredentials | undefined>;
  /** The host keys trusted for the Repository (configured hosts and its pinned key). */
  trustedHostKeys(repository: RepositoryConnection): TrustedHostKeys;
  /** Deletes the private half; a no-op when it is already gone. */
  remove(secretRef: string): Promise<void>;
  /**
   * The references of every stored Deploy key's private half at least `ageMs` old, by the
   * secret store's clock; never a key.
   */
  listOlderThan(ageMs: number): Promise<string[]>;
}
