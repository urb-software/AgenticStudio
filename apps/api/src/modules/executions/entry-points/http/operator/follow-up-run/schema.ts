import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { followUpSourceSchema } from '../../shared/run-response.js';
import { REVIEW_COMMENTS_MAX } from '../../../../domain/value-objects/review-comments.js';
import { FOLLOW_UP_MAX_LENGTH } from '../../../../domain/value-objects/follow-up.js';

export const followUpRunRequestSchema = z
  .strictObject({
    text: z
      .string()
      .trim()
      .min(1, { error: 'Enter a Follow-up.' })
      .max(FOLLOW_UP_MAX_LENGTH, { error: `Use at most ${FOLLOW_UP_MAX_LENGTH} characters.` }),
    source: followUpSourceSchema.optional(),
    reviewCommentIds: z.array(z.string().min(1).max(40)).min(1).max(REVIEW_COMMENTS_MAX).optional(),
  })
  .refine((body) => (body.source === 'review_comments') === (body.reviewCommentIds !== undefined), {
    path: ['reviewCommentIds'],
    error: 'Name the selected review comments with the source review_comments, and only then.',
  })
  .meta({ id: 'FollowUpRunRequest' });

export class FollowUpRunRequestDto extends createZodDto(followUpRunRequestSchema) {}
