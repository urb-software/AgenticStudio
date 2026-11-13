import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  INTEGRATION_BRANCH_MAX_LENGTH,
  INTEGRATION_BRANCH_PATTERN,
  INVALID_INTEGRATION_BRANCH_MESSAGE,
} from '../../domain/value-objects/integration-branch.js';
import { REPOSITORY_URL_MAX_LENGTH } from '../../domain/value-objects/repository-url.js';

/**
 * `POST /api/projects/:id/repository` body. Every violation is a 422 with field errors.
 * The branch rule is one pattern, so the generated client gets it as a form hint. The URL
 * rules (HTTPS only, no credentials, SSH refused for now) depend on the test-only
 * fixture-remote setting, so they run in the handler (`RepositoryUrl`), still before
 * anything is stored or enqueued; the schema publishes only the URL's length.
 */
export const connectRepositoryRequestSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1, { error: 'Enter the repository URL.', abort: true })
      .max(REPOSITORY_URL_MAX_LENGTH, {
        error: `Use at most ${REPOSITORY_URL_MAX_LENGTH} characters.`,
      }),
    integrationBranch: z
      .string()
      .trim()
      .min(1, { error: 'Enter the integration branch.', abort: true })
      .max(INTEGRATION_BRANCH_MAX_LENGTH, {
        error: `Use at most ${INTEGRATION_BRANCH_MAX_LENGTH} characters.`,
      })
      .regex(INTEGRATION_BRANCH_PATTERN, { error: INVALID_INTEGRATION_BRANCH_MESSAGE }),
  })
  .meta({ id: 'ConnectRepositoryRequest' });

export class ConnectRepositoryRequestDto extends createZodDto(connectRepositoryRequestSchema) {}

export type ConnectRepositoryRequest = z.infer<typeof connectRepositoryRequestSchema>;
