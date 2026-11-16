import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { FOLLOW_UP_MAX_LENGTH } from '../../domain/entities/run.js';

/**
 * `POST /api/runs/:runId/bring-up-to-date` body (Issue #147): the operator's optional note for
 * the agent, trimmed, at most as long as a Follow-up. Closed: an unknown field is an error; an
 * empty or absent note means none. An invalid body is a 422, so the endpoint validates it.
 */
export const bringUpToDateRequestSchema = z
  .strictObject({
    note: z
      .string()
      .trim()
      .max(FOLLOW_UP_MAX_LENGTH, { error: `Use at most ${FOLLOW_UP_MAX_LENGTH} characters.` })
      .optional(),
  })
  .meta({ id: 'BringUpToDateRequest' });

export class BringUpToDateRequestDto extends createZodDto(bringUpToDateRequestSchema) {}
