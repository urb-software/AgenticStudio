import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { SECRET_STORE, type SecretStore } from '../../../../../platform/secrets/index.js';
import { EnvironmentFileSnapshotRule } from '../../../domain/value-objects/environment-file-snapshot-rule.js';
import { RUN_ENVIRONMENT_FILE_ORPHAN_AGE_MS } from '../../../domain/value-objects/run-environment-file.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  RUN_ENVIRONMENT_FILE_SECRET_OWNER,
  RUN_SNAPSHOT_SETTINGS,
  type RunSnapshotSettings,
} from '../../ports/environment-file-snapshots.js';

export type ReleaseFinalSnapshotsResult = void;

/**
 * A final Run stores no more events, so its redaction no longer needs the values.
 * Never throws: a failure is logged by secret id (redacted) and retried at the next call.
 */
@Injectable()
export class ReleaseFinalSnapshotsHandler {
  private readonly logger = new Logger('EnvironmentFileSnapshots');

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RUN_SNAPSHOT_SETTINGS) private readonly settings: RunSnapshotSettings,
  ) {}

  async execute(): Promise<ReleaseFinalSnapshotsResult> {
    const rule = EnvironmentFileSnapshotRule.at(this.clock.now(), this.settings.retentionDays);
    try {
      for (const { runId, secretRef } of await this.runs.listReleasableEnvironmentFileSecrets(
        rule.retryableFinishedBefore,
      )) {
        await this.secrets.delete(secretRef);
        await this.runs.clearEnvironmentFileSecret(runId, secretRef);
      }
      // A snapshot no Run references (a claim stopped between storing it and recording it) is
      // deleted after an hour.
      const orphans = await this.secrets.listOlderThan(
        RUN_ENVIRONMENT_FILE_SECRET_OWNER,
        RUN_ENVIRONMENT_FILE_ORPHAN_AGE_MS,
      );
      if (orphans.length === 0) return;
      const referenced = new Set(await this.runs.listEnvironmentFileSecretRefs());
      for (const secretRef of orphans.filter((ref) => !referenced.has(ref))) {
        await this.secrets.delete(secretRef);
        this.logger.log(`Deleted the orphaned Environment file snapshot ${secretRef}.`);
      }
    } catch (error) {
      this.logger.warn(
        `Could not release Environment file snapshots; retried later. ${redactSecrets(String(error))}`,
      );
    }
  }
}
