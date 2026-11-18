import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { followUpSourceSchema } from '../../shared/run-response.js';
import { ReviewComment } from '../../../../domain/value-objects/review-comment.js';
import { RunConversation } from '../../../../domain/value-objects/run-conversation.js';

export const followUpRunRequestSchema = z
  .strictObject({
    text: z
      .string()
      .trim()
      .min(1, { error: 'Enter a Follow-up.' })
      .max(RunConversation.FOLLOW_UP_MAX_LENGTH, {
        error: `Use at most ${RunConversation.FOLLOW_UP_MAX_LENGTH} characters.`,
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
