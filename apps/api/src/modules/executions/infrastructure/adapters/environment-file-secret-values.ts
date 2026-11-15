import { Inject, Injectable } from '@nestjs/common';
import {
  SECRET_STORE,
  SecretNotFoundError,
  type SecretStore,
} from '../../../../platform/secrets/index.js';
import { RUN_REPOSITORY, type RunRepository } from '../../domain/repositories/run-repository.js';
import { environmentFileValues } from '../../domain/services/environment-file-values.js';
import type { RunSecretValues } from '../../ports/run-secret-values.js';

/**
 * {@link RunSecretValues} from the Run's Environment file snapshot (Issue #104): its values,
 * dotenv style, for log redaction. None when the Run was given no file, or once its snapshot
 * was deleted (the Run is final, and nothing more is stored for it). Any other failure of the
 * secret store propagates, so nothing is stored unredacted.
 */
@Injectable()
export class EnvironmentFileSecretValues implements RunSecretValues {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
  ) {}

  async forRun(runId: string): Promise<string[]> {
    const secretRef = await this.runs.findEnvironmentFileSecret(runId);
    if (secretRef === null) return [];
    try {
      return environmentFileValues(await this.secrets.get(secretRef));
    } catch (error) {
      if (error instanceof SecretNotFoundError) return [];
      throw error;
    }
  }
}
