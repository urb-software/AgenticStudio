import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { REVIEW_COMMENT_SCOPES } from '../../../../domain/value-objects/review-comment-scope.js';

export const loadReviewCommentsRequestSchema = z
  .strictObject({ scope: z.enum(REVIEW_COMMENT_SCOPES) })
  .meta({ id: 'LoadReviewCommentsRequest' });

export class LoadReviewCommentsRequestDto extends createZodDto(loadReviewCommentsRequestSchema) {}
