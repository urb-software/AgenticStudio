import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { followUpSourceSchema } from '../../contracts/http/run-response.js';
import { FOLLOW_UP_MAX_LENGTH } from '../../domain/entities/run.js';

/**
 * `POST /api/runs/:runId/follow-up` body (Issue #141): the operator's further instruction,
 * trimmed, then 1–10 000 characters. Issue #145: `source` (optional) says the text was prepared
 * from the failing Pull request checks, which the operator reviewed and may have edited; the
 * text sent is the operator's. Closed: an unknown field is an error. An invalid body is a
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
  })
  .meta({ id: 'FollowUpRunRequest' });

export class FollowUpRunRequestDto extends createZodDto(followUpRunRequestSchema) {}
