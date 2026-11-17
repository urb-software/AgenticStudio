import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import { DeployKeySweepPolicy } from '../../../domain/value-objects/deploy-key-sweep-policy.js';
import {
  DEPLOY_KEY_SWEEP_SETTINGS,
  DEPLOY_KEYS,
  type DeployKeys,
  type DeployKeySweepSettings,
} from '../../ports/deploy-keys.js';

/**
 * Feature: deleting Deploy keys no Repository references (Issue #76). A key is orphaned when
 * the process stops between storing it and saving the Repository's reference, or when its
 * delete fails after a failed SSH Repository was replaced over HTTPS.
 *
 * Only secrets under the Deploy-key owner label are candidates, and of those only the ones
 * older than the grace period, by the secret store's clock. A candidate any Repository still
 * references, in any state, is never deleted. A key older than the grace period becomes
 * referenced again only by a Retry that keeps it, and that Retry is saved only while its
 * Repository still references the key (`keepsDeployKey`), so a key the sweep found
 * unreferenced is never saved again.
 *
 * Runs at start-up, after the repository queue is reconciled and before its worker starts
 * (`RepositoryStartupRecovery`), and after a Connect fails to delete a key (Connect repeats the selection inline, #163). Each delete is
 * logged by the secret's id only. Never throws: a failure is logged (redacted) and the next
 * sweep tries again.
 */
@Injectable()
export class SweepOrphanedDeployKeysHandler {
  private readonly logger = new Logger('DeployKeySweep');

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(DEPLOY_KEYS) private readonly deployKeys: DeployKeys,
    @Inject(DEPLOY_KEY_SWEEP_SETTINGS) private readonly settings: DeployKeySweepSettings,
  ) {}

  async sweep(): Promise<void> {
    let orphans: string[];
    try {
      const policy = DeployKeySweepPolicy.of(this.settings.gracePeriodMs);
      const candidates = await this.deployKeys.listOlderThan(policy.gracePeriodMs);
      if (candidates.length === 0) return;
      orphans = policy.orphans(candidates, await this.projects.listDeployKeySecretRefs());
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
