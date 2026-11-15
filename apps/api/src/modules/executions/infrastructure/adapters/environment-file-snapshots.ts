import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { SECRET_STORE, type SecretStore } from '../../../../platform/secrets/index.js';
import {
  RUN_ENVIRONMENT_FILE_ORPHAN_AGE_MS,
  RUN_ENVIRONMENT_FILE_SECRET_OWNER,
} from '../../domain/entities/run-environment-file.js';
import { RUN_REPOSITORY, type RunRepository } from '../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  type EnvironmentFileSnapshots,
  RUN_SNAPSHOT_SETTINGS,
  type RunSnapshotSettings,
} from '../../ports/environment-file-snapshots.js';

/**
 * {@link EnvironmentFileSnapshots} over the secret store (Issue #104): deletes the Environment file snapshots of Runs that are final. A final
 * Run stores no more events (a worker appends only while it holds the Run), so its redaction
 * no longer needs the values. Called when a worker reports a final state, and from the
 * lost-worker schedule for every other way a Run ends (lost worker, and later stories'
 * cancel and time limits). The schedule also deletes snapshots no Run references that are
 * older than an hour (a claim that stopped between storing one and recording it). Never
 * throws: a failure is logged by secret id (redacted) and retried at the next call.
 */
@Injectable()
export class SecretStoreEnvironmentFileSnapshots implements EnvironmentFileSnapshots {
  private readonly logger = new Logger('EnvironmentFileSnapshots');

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RUN_SNAPSHOT_SETTINGS) private readonly settings: RunSnapshotSettings,
  ) {}

  /**
   * Deletes the snapshot of every final Run that no longer needs it (a retryable failed
   * delivery keeps it for the retention period), and old orphans.
   */
  async releaseFinal(): Promise<void> {
    const retryableFinishedBefore = new Date(
      this.clock.now().getTime() - this.settings.retentionDays * 24 * 60 * 60 * 1000,
    );
    try {
      for (const { runId, secretRef } of await this.runs.listReleasableEnvironmentFileSecrets(
        retryableFinishedBefore,
      )) {
        await this.release(runId, secretRef);
      }
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
      this.warn('Could not release Environment file snapshots', error);
    }
  }

  /** Deletes the snapshot of one Run that no longer needs it (the caller decides when). */
  async releaseFor(runId: string): Promise<void> {
    try {
      const secretRef = await this.runs.findEnvironmentFileSecret(runId);
      if (secretRef !== null) await this.release(runId, secretRef);
    } catch (error) {
      this.warn(`Could not release the Environment file snapshot of run ${runId}`, error);
    }
  }

  private async release(runId: string, secretRef: string): Promise<void> {
    await this.secrets.delete(secretRef);
    await this.runs.clearEnvironmentFileSecret(runId, secretRef);
  }

  private warn(what: string, error: unknown): void {
    this.logger.warn(`${what}; retried later. ${redactSecrets(String(error))}`);
  }
}
