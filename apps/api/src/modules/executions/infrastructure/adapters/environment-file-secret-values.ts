import { Inject, Injectable } from '@nestjs/common';
import {
  SECRET_STORE,
  SecretNotFoundError,
  type SecretStore,
} from '../../../../platform/secrets/index.js';
import { RUN_REPOSITORY, type RunRepository } from '../../domain/repositories/run-repository.js';
import { EnvironmentFileContent } from '../../domain/value-objects/environment-file-content.js';
import type { RunSecretValues } from '../../application/ports/run-secret-values.js';

/**
 * None when the Run has no file or its snapshot was deleted; any other secret-store failure
 * propagates, so nothing is stored unredacted.
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
      return EnvironmentFileContent.of(await this.secrets.get(secretRef)).valuesToRedact();
    } catch (error) {
      if (error instanceof SecretNotFoundError) return [];
      throw error;
    }
  }
}
