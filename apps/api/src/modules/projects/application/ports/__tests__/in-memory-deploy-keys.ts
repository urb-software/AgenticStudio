import { NoTrustedHostKeyError } from '../../../domain/errors/repository-connection-errors.js';
import { type RepositoryConnection } from '../../../domain/entities/repository-connection.js';
import { testDeployKey } from '../../../domain/value-objects/__tests__/test-deploy-key.js';
import { DeployKeyComment } from '../../../domain/value-objects/deploy-key-comment.js';
import { type KnownHost } from '../../../domain/value-objects/known-host.js';
import { TrustedHostKeys } from '../../../domain/value-objects/trusted-host-keys.js';
import { DEPLOY_KEY_SECRET_OWNER, type DeployKeys, type StoredDeployKey } from '../deploy-keys.js';
import type { SshCredentials } from '../repository-git.js';
import { InMemorySecretStore } from './in-memory-secret-store.js';

/**
 * In-memory {@link DeployKeys} for handler tests, over an {@link InMemorySecretStore} the test
 * reads and breaks (`secrets.values`, `secrets.now`, `secrets.failWith`), like the real
 * adapter over the platform's secret store.
 */
export class InMemoryDeployKeys implements DeployKeys {
  constructor(
    readonly secrets = new InMemorySecretStore(),
    private readonly knownHosts: readonly KnownHost[] = [],
  ) {}

  async create(projectName: string): Promise<StoredDeployKey> {
    const { privateKey, publicKey } = testDeployKey(DeployKeyComment.of(projectName).value);
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
    return TrustedHostKeys.of(repository, this.knownHosts);
  }

  remove(secretRef: string): Promise<void> {
    return this.secrets.delete(secretRef);
  }

  listOlderThan(ageMs: number): Promise<string[]> {
    return this.secrets.listOlderThan(DEPLOY_KEY_SECRET_OWNER, ageMs);
  }
}
