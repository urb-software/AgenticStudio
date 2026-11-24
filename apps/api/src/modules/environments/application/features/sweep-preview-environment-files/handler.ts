import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { SECRET_STORE, type SecretStore } from '../../../../../platform/secrets/index.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import {
  PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER,
  PREVIEW_SNAPSHOT_GRACE_MS,
} from '../../ports/preview-environment-file-snapshots.js';

/**
 * A snapshot is orphaned when the process stops between storing it and saving its reference, or
 * a delete fails. Only snapshots past the grace period are candidates, and one an operation
 * still references is never deleted. Never throws.
 */
@Injectable()
export class SweepPreviewEnvironmentFilesHandler {
  private readonly logger = new Logger('PreviewEnvironmentFileSweep');

  constructor(
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
  ) {}

  async execute(): Promise<void> {
    let orphans: string[];
    try {
      // The database first: with it unreachable the secret store is not touched.
      const referenced = new Set(await this.operations.listEnvironmentFileSecrets());
      const candidates = await this.secrets.listOlderThan(
        PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER,
        PREVIEW_SNAPSHOT_GRACE_MS,
      );
      if (candidates.length === 0) return;
      orphans = candidates.filter((secretId) => !referenced.has(secretId));
    } catch (error) {
      this.logger.warn(
        `Could not sweep orphaned Preview Environment file snapshots. ${redactSecrets(String(error))}`,
      );
      return;
    }
    for (const secretId of orphans) {
      try {
        await this.secrets.delete(secretId);
        this.logger.log(`Swept the orphaned Environment file snapshot ${secretId}.`);
      } catch (error) {
        this.logger.warn(
          `Could not delete the orphaned snapshot ${secretId}. ${redactSecrets(String(error))}`,
        );
      }
    }
  }
}
