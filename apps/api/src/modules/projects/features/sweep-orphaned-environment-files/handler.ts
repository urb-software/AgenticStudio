import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { SECRET_STORE, type SecretStore } from '../../../../platform/secrets/index.js';
import { ENVIRONMENT_FILE_SECRET_OWNER } from '../../domain/entities/environment-file.js';
import {
  ENVIRONMENT_FILE_REPOSITORY,
  type EnvironmentFileRepository,
} from '../../domain/repositories/environment-file-repository.js';
import {
  DEPLOY_KEY_SWEEP_SETTINGS,
  type DeployKeySweepSettings,
} from '../sweep-orphaned-deploy-keys/handler.js';

/**
 * Feature (Issue #104): deleting Environment file contents no project references any more,
 * like the Deploy-key sweep (Issue #76) and with its grace period. A content is orphaned when
 * the process stops between storing it and saving the project's reference, when deleting a
 * replaced or removed content fails, or when two first saves race. Only secrets under the
 * Environment file owner label and older than the grace period are candidates; a referenced
 * one is never deleted. Runs at start-up, after the Deploy-key sweep (`repository-jobs`); never
 * throws (a failure is logged, redacted, and the next start-up tries again). Each delete is
 * logged by the secret's id only.
 */
@Injectable()
export class SweepOrphanedEnvironmentFilesHandler {
  private readonly logger = new Logger('EnvironmentFileSweep');

  constructor(
    @Inject(ENVIRONMENT_FILE_REPOSITORY) private readonly files: EnvironmentFileRepository,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(DEPLOY_KEY_SWEEP_SETTINGS) private readonly settings: DeployKeySweepSettings,
  ) {}

  async sweep(): Promise<void> {
    let orphans: string[];
    try {
      const candidates = await this.secrets.listOlderThan(
        ENVIRONMENT_FILE_SECRET_OWNER,
        this.settings.gracePeriodMs,
      );
      if (candidates.length === 0) return;
      const referenced = new Set(await this.files.listSecretRefs());
      orphans = candidates.filter((secretRef) => !referenced.has(secretRef));
    } catch (error) {
      this.logger.warn(
        `Could not sweep orphaned Environment file secrets. ${redactSecrets(String(error))}`,
      );
      return;
    }
    for (const secretRef of orphans) {
      try {
        await this.secrets.delete(secretRef);
        this.logger.log(`Deleted the orphaned Environment file secret ${secretRef}.`);
      } catch (error) {
        this.logger.warn(
          `Could not delete the orphaned Environment file secret ${secretRef}. ` +
            redactSecrets(String(error)),
        );
      }
    }
  }
}
