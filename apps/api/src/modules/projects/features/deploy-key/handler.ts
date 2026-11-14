import { Inject, Injectable } from '@nestjs/common';
import { SECRET_STORE, type SecretStore } from '../../../../platform/secrets/index.js';
import type { RepositoryConnection } from '../../domain/entities/repository.js';
import { knownHostName, type SshKnownHost } from '../../../../platform/config/ssh-known-hosts.js';
import { sshRemoteOf } from '../../domain/value-objects/repository-url.js';
import { deployKeyComment, generateDeployKey } from '../../domain/value-objects/ssh-key.js';
import type { SshCredentials } from '../../ports/repository-git.js';

/**
 * The secret store owner label of every Deploy key's private half (Issue #76): what the
 * orphan sweep (`sweep-orphaned-deploy-keys`) lists, and nothing else.
 */
export const DEPLOY_KEY_SECRET_OWNER = 'projects.deploy-key';

/** DI token for {@link SshTrustSettings}. */
export const SSH_TRUST_SETTINGS = Symbol('SSH_TRUST_SETTINGS');

export interface SshTrustSettings {
  /** The Git hosts trusted without asking (`STUDIO_SSH_KNOWN_HOSTS`). */
  knownHosts: readonly SshKnownHost[];
}

/** A stored Deploy key: the public half and the secret store's reference to the private half. */
export interface StoredDeployKey {
  publicKey: string;
  secretRef: string;
}

/** Stored as the failure detail when no host key is trusted for an SSH operation. */
export const NO_TRUSTED_HOST_KEY_DETAIL =
  "Studio trusts no host key for this Git host. If the host's key changed as expected, " +
  'disconnect the repository and connect it again.';

/** No host key is trusted for the Repository's Git host: Studio does not connect. */
export class NoTrustedHostKeyError extends Error {
  constructor() {
    super(NO_TRUSTED_HOST_KEY_DETAIL);
    this.name = 'NoTrustedHostKeyError';
  }
}

/**
 * The Deploy key and host trust of SSH Repositories (Issue #62), shared by connect, verify,
 * clone, fetch and disconnect, and by the orphan sweep (Issue #76). The private key goes only through the secret store's public
 * entry point: it is created and stored here, read here for one Git operation at a time
 * (the Git adapter writes it owner-only for that operation and deletes it), and deleted
 * here. It is never returned to a caller outside the Git port, and never logged.
 */
@Injectable()
export class DeployKeyHandler {
  constructor(
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(SSH_TRUST_SETTINGS) private readonly settings: SshTrustSettings,
  ) {}

  /** Generates an ed25519 Deploy key commented `studio-<project name>` and stores its private half. */
  async create(projectName: string): Promise<StoredDeployKey> {
    const { privateKey, publicKey } = generateDeployKey(deployKeyComment(projectName));
    return {
      publicKey,
      secretRef: await this.secrets.put(privateKey, { owner: DEPLOY_KEY_SECRET_OWNER }),
    };
  }

  /**
   * The references of every stored Deploy key's private half at least `ageMs` old, by the
   * secret store's clock; never a key.
   */
  listOlderThan(ageMs: number): Promise<string[]> {
    return this.secrets.listOlderThan(DEPLOY_KEY_SECRET_OWNER, ageMs);
  }

  /** Deletes the private half; a no-op when it is already gone. */
  delete(secretRef: string): Promise<void> {
    return this.secrets.delete(secretRef);
  }

  /**
   * The host keys trusted for the Repository's Git host: those configured for it and the one
   * pinned for this Repository, if any. Empty for a host Studio has to ask about, and for a
   * URL that is not SSH.
   */
  trustedHostKeys(repository: RepositoryConnection): string[] {
    const hostName = this.hostNameOf(repository.url);
    if (hostName === null) return [];
    const keys = this.settings.knownHosts
      .filter((entry) => entry.hosts.includes(hostName))
      .map((entry) => entry.key);
    return repository.pinnedHostKey ? [...keys, repository.pinnedHostKey] : keys;
  }

  /** The known_hosts name of an SSH URL's Git host (`host` or `[host]:port`), else `null`. */
  hostNameOf(url: string): string | null {
    const remote = sshRemoteOf(url);
    return remote ? knownHostName(remote.host, remote.port) : null;
  }

  /**
   * The SSH material for one Git operation on the Repository, or `undefined` when it has no
   * Deploy key (HTTPS). Throws {@link NoTrustedHostKeyError} when no host key is trusted, and
   * the secret store's errors.
   */
  async credentials(repository: RepositoryConnection): Promise<SshCredentials | undefined> {
    if (repository.deployKeySecret === null) return undefined;
    const hostKeys = this.trustedHostKeys(repository);
    if (hostKeys.length === 0) throw new NoTrustedHostKeyError();
    return { privateKey: await this.secrets.get(repository.deployKeySecret), hostKeys };
  }
}
