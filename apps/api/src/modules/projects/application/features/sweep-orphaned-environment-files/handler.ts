import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import {
  ENVIRONMENT_FILE_REPOSITORY,
  type EnvironmentFileRepository,
} from '../../../domain/repositories/environment-file-repository.js';
import {
  ENVIRONMENT_FILE_CONTENTS,
  type EnvironmentFileContents,
} from '../../ports/environment-file-contents.js';

/**
 * Only contents past the grace period are candidates (two first saves can race); a referenced one
 * is never deleted. Never throws.
 */
@Injectable()
export class SweepOrphanedEnvironmentFilesHandler {
  private readonly logger = new Logger('EnvironmentFileSweep');

  constructor(
    @Inject(ENVIRONMENT_FILE_REPOSITORY) private readonly files: EnvironmentFileRepository,
    @Inject(ENVIRONMENT_FILE_CONTENTS) private readonly contents: EnvironmentFileContents,
  ) {}

  async execute(): Promise<void> {
    let orphans: string[];
    try {
      const candidates = await this.contents.listOld();
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
      // Logs a failed delete itself; the next sweep tries again.
      await this.contents.discard(secretRef);
      this.logger.log(`Swept the orphaned Environment file secret ${secretRef}.`);
    }
  }
}
