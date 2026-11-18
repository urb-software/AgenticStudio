import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { followUpSourceSchema } from '../../shared/run-response.js';
import { ReviewComment } from '../../../../domain/value-objects/review-comment.js';
import { FollowUpText } from '../../../../domain/value-objects/follow-up-text.js';

export const followUpRunRequestSchema = z
  .strictObject({
    text: z
      .string()
      .trim()
      .min(1, { error: 'Enter a Follow-up.' })
      .max(FollowUpText.MAX_LENGTH, {
        error: `Use at most ${FollowUpText.MAX_LENGTH} characters.`,
      }),
    source: followUpSourceSchema.optional(),
    reviewCommentIds: z
      .array(z.string().min(1).max(40))
      .min(1)
      .max(ReviewComment.SET_MAX)
      .optional(),
  })
  .refine((body) => (body.source === 'review_comments') === (body.reviewCommentIds !== undefined), {
    path: ['reviewCommentIds'],
    error: 'Name the selected review comments with the source review_comments, and only then.',
  })
  .meta({ id: 'FollowUpRunRequest' });

export class FollowUpRunRequestDto extends createZodDto(followUpRunRequestSchema) {}
