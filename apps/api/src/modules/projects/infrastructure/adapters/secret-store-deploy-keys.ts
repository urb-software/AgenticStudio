import { Inject, Injectable } from '@nestjs/common';
import type { SshKnownHost } from '../../../../platform/config/ssh-known-hosts.js';
import { SECRET_STORE, type SecretStore } from '../../../../platform/secrets/index.js';
import {
  DEPLOY_KEY_SECRET_OWNER,
  type DeployKeys,
  type StoredDeployKey,
} from '../../application/ports/deploy-keys.js';
import type { SshCredentials } from '../../application/ports/repository-git.js';
import {
  NoTrustedHostKeyError,
  type RepositoryConnection,
} from '../../domain/entities/repository.js';
import { deployKeyComment, generateDeployKey } from '../../domain/value-objects/ssh-key.js';
import { TrustedHostKeys } from '../../domain/value-objects/trusted-host-keys.js';

/** DI token for {@link SshTrustSettings}. */
export const SSH_TRUST_SETTINGS = Symbol('SSH_TRUST_SETTINGS');

export interface SshTrustSettings {
  /** The Git hosts trusted without asking (`STUDIO_SSH_KNOWN_HOSTS`). */
  knownHosts: readonly SshKnownHost[];
}

/** {@link DeployKeys} over the platform's secret store (ADR 0001). */
@Injectable()
export class SecretStoreDeployKeys implements DeployKeys {
  constructor(
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(SSH_TRUST_SETTINGS) private readonly settings: SshTrustSettings,
  ) {}

  async create(projectName: string): Promise<StoredDeployKey> {
    const { privateKey, publicKey } = generateDeployKey(deployKeyComment(projectName));
    return {
      publicKey,
      secretRef: await this.secrets.put(privateKey, { owner: DEPLOY_KEY_SECRET_OWNER }),
    };
  }

  async credentials(repository: RepositoryConnection): Promise<SshCredentials | undefined> {
    if (repository.deployKeySecret === null) return undefined;
    const trusted = this.trustedHostKeys(repository);
    if (trusted.isEmpty) throw new NoTrustedHostKeyError();
    return {
      privateKey: await this.secrets.get(repository.deployKeySecret),
      hostKeys: trusted.keys,
    };
  }

  trustedHostKeys(repository: RepositoryConnection): TrustedHostKeys {
    return TrustedHostKeys.of(repository, this.settings.knownHosts);
  }

  remove(secretRef: string): Promise<void> {
    return this.secrets.delete(secretRef);
  }

  listOlderThan(ageMs: number): Promise<string[]> {
    return this.secrets.listOlderThan(DEPLOY_KEY_SECRET_OWNER, ageMs);
  }
}
