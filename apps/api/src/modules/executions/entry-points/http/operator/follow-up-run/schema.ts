import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { followUpSourceSchema } from '../../shared/run-response.js';
import { REVIEW_COMMENTS_MAX } from '../../../../domain/value-objects/review-comments.js';
import { FOLLOW_UP_MAX_LENGTH } from '../../../../domain/entities/run.js';

/**
 * `POST /api/runs/:runId/follow-up` body (Issue #141): the operator's further instruction,
 * trimmed, then 1–10 000 characters. Issue #145: `source` (optional) says the text was prepared
 * from the failing Pull request checks, which the operator reviewed and may have edited; the
 * text sent is the operator's. Issue #146: `source: "review_comments"` comes with
 * `reviewCommentIds`, the ids of the Review comments the operator selected (at most one hundred,
 * all from the loaded set), and with nothing else. Closed: an unknown field is an error. An invalid body is a
 * 422 (the agreed contract), so the endpoint validates it.
 */
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
