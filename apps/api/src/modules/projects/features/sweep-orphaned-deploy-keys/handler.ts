import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';
import { DeployKeyHandler } from '../deploy-key/handler.js';

/**
 * How old an unreferenced Deploy key must be before the sweep deletes it (Issue #76): far
 * longer than a Connect takes between storing a new key and saving the Repository that
 * references it, so the sweep never races a Connect in flight.
 */
export const DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS = 60 * 60 * 1000;

/** DI token for {@link DeployKeySweepSettings}. */
export const DEPLOY_KEY_SWEEP_SETTINGS = Symbol('DEPLOY_KEY_SWEEP_SETTINGS');

export interface DeployKeySweepSettings {
  /** {@link DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS} in production; tests may pass a shorter one. */
  gracePeriodMs: number;
}

/**
 * Feature: deleting Deploy keys no Repository references (Issue #76). A key is orphaned when
 * the process stops between storing it and saving the Repository's reference, or when its
 * delete fails after a failed SSH Repository was replaced over HTTPS.
 *
 * Only secrets under the Deploy-key owner label are candidates, and of those only the ones
 * older than the grace period, by the secret store's clock. A candidate any Repository still
 * references, in any state, is never deleted. The candidates are listed before the
 * references: a key older than the grace period becomes referenced only by a Retry that keeps
 * a key its Repository already references, so no reference can appear after it was read.
 *
 * Runs at start-up, after the repository queue is reconciled and before its worker starts
 * (`repository-jobs`), and after a Connect fails to delete a replaced key. Each delete is
 * logged by the secret's id only. Never throws: a failure is logged (redacted) and the next
 * sweep tries again.
 */
@Injectable()
export class SweepOrphanedDeployKeysHandler {
  private readonly logger = new Logger('DeployKeySweep');

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    private readonly deployKeys: DeployKeyHandler,
    @Inject(DEPLOY_KEY_SWEEP_SETTINGS) private readonly settings: DeployKeySweepSettings,
  ) {}

  async sweep(): Promise<void> {
    let orphans: string[];
    try {
      const candidates = await this.deployKeys.listOlderThan(this.settings.gracePeriodMs);
      if (candidates.length === 0) return;
      const referenced = new Set(await this.projects.listDeployKeySecrets());
      orphans = candidates.filter((secretRef) => !referenced.has(secretRef));
    } catch (error) {
      this.logger.warn(
        `Could not sweep orphaned Deploy keys; the next sweep tries again. ${redactSecrets(String(error))}`,
      );
      return;
    }
    for (const secretRef of orphans) {
      try {
        await this.deployKeys.delete(secretRef);
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
