import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import { SECRET_STORE, type SecretStore } from '../../../../platform/secrets/index.js';
import { RUN_REPOSITORY, type RunRepository } from '../../domain/repositories/run-repository.js';
import { type EnvironmentFileSnapshots } from '../../application/ports/environment-file-snapshots.js';

/** Never throws: a failure is logged (redacted) and retried at the next call. */
@Injectable()
export class SecretStoreEnvironmentFileSnapshots implements EnvironmentFileSnapshots {
  private readonly logger = new Logger('EnvironmentFileSnapshots');

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
  ) {}

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
