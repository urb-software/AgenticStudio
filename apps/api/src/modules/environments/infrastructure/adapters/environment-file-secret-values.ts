import { environmentFileValuesToRedact } from '@agentic-studio/log-redaction';
import { Inject, Injectable } from '@nestjs/common';
import {
  SECRET_STORE,
  SecretNotFoundError,
  type SecretStore,
} from '../../../../platform/secrets/index.js';
import type { PreviewSecretValues } from '../../application/ports/preview-secret-values.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../domain/repositories/preview-operation-repository.js';

/**
 * None when the operation holds no file or its snapshot was deleted; any other secret-store
 * failure propagates, so nothing is stored unredacted.
 */
@Injectable()
export class EnvironmentFileSecretValues implements PreviewSecretValues {
  constructor(
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
  ) {}

  async forOperation(operationId: string): Promise<string[]> {
    const secretId = await this.operations.findEnvironmentFileSecret(operationId);
    if (secretId === null) return [];
    try {
      return environmentFileValuesToRedact(await this.secrets.get(secretId));
    } catch (error) {
      if (error instanceof SecretNotFoundError) return [];
      throw error;
    }
  }
}
