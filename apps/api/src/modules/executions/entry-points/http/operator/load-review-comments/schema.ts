import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { REVIEW_COMMENT_SCOPES } from '../../../../domain/value-objects/review-comments.js';

/**
 * `POST /api/runs/:runId/pull-request/review-comments/load` body (Issue #146): what to load, the
 * comments created since the Run's latest result, or all that are unresolved. Closed; an invalid
 * body is a 422, so the endpoint validates it.
 */
export const loadReviewCommentsRequestSchema = z
  .strictObject({ scope: z.enum(REVIEW_COMMENT_SCOPES) })
  .meta({ id: 'LoadReviewCommentsRequest' });

export class LoadReviewCommentsRequestDto extends createZodDto(loadReviewCommentsRequestSchema) {}
