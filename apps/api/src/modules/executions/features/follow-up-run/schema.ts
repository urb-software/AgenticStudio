import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { FOLLOW_UP_MAX_LENGTH } from '../../domain/entities/run.js';

/**
 * `POST /api/runs/:runId/follow-up` body (Issue #141): the operator's further instruction,
 * trimmed, then 1–10 000 characters. Closed: an unknown field is an error. An invalid body is a
 * 422 (the agreed contract), so the endpoint validates it.
 */
export const followUpRunRequestSchema = z
  .strictObject({
    text: z
      .string()
      .trim()
      .min(1, { error: 'Enter a Follow-up.' })
      .max(FOLLOW_UP_MAX_LENGTH, { error: `Use at most ${FOLLOW_UP_MAX_LENGTH} characters.` }),
  })
  .meta({ id: 'FollowUpRunRequest' });

export class FollowUpRunRequestDto extends createZodDto(followUpRunRequestSchema) {}
