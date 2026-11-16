import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `POST /api/runs/:runId/pull-request/refresh` body (Issue #142), optional: `onOpen` says the
 * request is the Run page's own, made when it was opened, which asks at most once a minute per
 * Run. The Refresh action sends none and asks whenever no refresh is under way. Closed.
 */
export const refreshPullRequestRequestSchema = z
  .strictObject({ onOpen: z.boolean().optional() })
  .meta({ id: 'RefreshPullRequestRequest' });

export class RefreshPullRequestRequestDto extends createZodDto(refreshPullRequestRequestSchema) {}
