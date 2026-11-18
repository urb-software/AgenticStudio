import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  INTEGRATION_BRANCH_MAX_LENGTH,
  INTEGRATION_BRANCH_PATTERN,
  INVALID_INTEGRATION_BRANCH_MESSAGE,
} from '../../../../domain/value-objects/integration-branch.js';
import { REPOSITORY_URL_MAX_LENGTH } from '../../../../domain/value-objects/repository-url.js';

/**
 * `POST /api/projects/:id/repository` body; a violation or unknown field is a 422. URL rules
 * depend on a test-only setting, so they run in the handler (`RepositoryUrl`); the schema
 * publishes only the length.
 */
export const connectRepositoryRequestSchema = z
  .strictObject({
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
