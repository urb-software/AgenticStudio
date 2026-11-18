import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { DeployKeySweepPolicy } from '../../../domain/value-objects/deploy-key-sweep-policy.js';
import {
  DEPLOY_KEY_SWEEP_SETTINGS,
  DEPLOY_KEYS,
  type DeployKeys,
  type DeployKeySweepSettings,
} from '../../ports/deploy-keys.js';

/**
 * Only keys past the grace period are candidates; a referenced key is never deleted. Never throws.
 */
@Injectable()
export class SweepOrphanedDeployKeysHandler {
  private readonly logger = new Logger('DeployKeySweep');

  constructor(
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(DEPLOY_KEYS) private readonly deployKeys: DeployKeys,
    @Inject(DEPLOY_KEY_SWEEP_SETTINGS) private readonly settings: DeployKeySweepSettings,
  ) {}

  async execute(): Promise<void> {
    let orphans: string[];
    try {
      const policy = DeployKeySweepPolicy.of(this.settings.gracePeriodMs);
      const candidates = await this.deployKeys.listOlderThan(policy.gracePeriodMs);
      if (candidates.length === 0) return;
      orphans = policy.orphans(candidates, await this.repositories.listDeployKeySecretRefs());
    } catch (error) {
      this.logger.warn(
        `Could not sweep orphaned Deploy keys; the next sweep tries again. ${redactSecrets(String(error))}`,
      );
      return;
    }
    for (const secretRef of orphans) {
      try {
        await this.deployKeys.remove(secretRef);
        this.logger.log(`Deleted the orphaned Deploy key secret ${secretRef}.`);
      } catch (error) {
        this.logger.warn(
          `Could not delete the orphaned Deploy key secret ${secretRef}; the next sweep tries ` +
            `again. ${redactSecrets(String(error))}`,
        );
      }
    }
  }
}
