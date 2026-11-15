import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import {
  ENVIRONMENT_FILE_REPOSITORY,
  type EnvironmentFileRepository,
} from '../../domain/repositories/environment-file-repository.js';
import {
  ENVIRONMENT_FILE_CONTENTS,
  type EnvironmentFileContents,
} from '../../ports/environment-file-contents.js';

/**
 * Feature (Issue #104): deleting Environment file contents no project references any more,
 * like the Deploy-key sweep (Issue #76), after a grace period of an hour. A content is orphaned when
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
    @Inject(ENVIRONMENT_FILE_CONTENTS) private readonly contents: EnvironmentFileContents,
  ) {}

  async sweep(): Promise<void> {
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
