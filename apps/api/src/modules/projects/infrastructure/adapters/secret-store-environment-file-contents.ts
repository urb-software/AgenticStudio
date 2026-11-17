import { Inject, Injectable, Logger } from '@nestjs/common';
import { redactSecrets } from '../../../../platform/http/redact.js';
import {
  SECRET_STORE,
  SecretNotFoundError,
  type SecretStore,
} from '../../../../platform/secrets/index.js';
import { ENVIRONMENT_FILE_SECRET_OWNER } from '../../domain/value-objects/environment-file.js';
import type { EnvironmentFileContents } from '../../application/ports/environment-file-contents.js';

/**
 * How old an unreferenced content must be before the orphan sweep deletes it: far longer than
 * a save takes between storing the content and saving the project's reference to it.
 */
export const ENVIRONMENT_FILE_ORPHAN_AGE_MS = 60 * 60 * 1000;

/** {@link EnvironmentFileContents} over the platform's secret store (ADR 0001). */
@Injectable()
export class SecretStoreEnvironmentFileContents implements EnvironmentFileContents {
  private readonly logger = new Logger('EnvironmentFile');

  constructor(@Inject(SECRET_STORE) private readonly secrets: SecretStore) {}

  store(content: string): Promise<string> {
    return this.secrets.put(content, { owner: ENVIRONMENT_FILE_SECRET_OWNER });
  }

  async read(reference: string): Promise<string | null> {
    try {
      return await this.secrets.get(reference);
    } catch (error) {
      if (error instanceof SecretNotFoundError) return null;
      throw error;
    }
  }

  async discard(reference: string): Promise<void> {
    try {
      await this.secrets.delete(reference);
    } catch (error) {
      this.logger.warn(
        `Could not delete the Environment file secret ${reference}; the orphan sweep deletes ` +
          `it later. ${redactSecrets(String(error))}`,
      );
    }
  }

  listOld(): Promise<string[]> {
    return this.secrets.listOlderThan(
      ENVIRONMENT_FILE_SECRET_OWNER,
      ENVIRONMENT_FILE_ORPHAN_AGE_MS,
    );
  }
}
