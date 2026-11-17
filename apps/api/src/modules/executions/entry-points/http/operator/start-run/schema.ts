import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PROVIDERS } from '../../../../domain/value-objects/provider.js';
import { TASK_MAX_LENGTH } from '../../../../domain/value-objects/task.js';

/**
 * `POST /api/projects/:id/runs` body (Issue #96). The Task is trimmed, then must hold 1–20 000
 * characters as zod counts them (UTF-16 code units; PostgreSQL VARCHAR(20000) counts
 * characters, so a valid Task always fits). Closed: an unknown field is an error. An invalid
 * body is a 422, not the API's usual 400 (the agreed contract), so the endpoint validates it.
 */
export const startRunRequestSchema = z
  .strictObject({
    task: z
      .string()
      .trim()
      .min(1, { error: 'Enter a task.' })
      .max(TASK_MAX_LENGTH, { error: `Use at most ${TASK_MAX_LENGTH} characters.` }),
    provider: z.enum(PROVIDERS),
  })
  .meta({ id: 'StartRunRequest' });

export class StartRunRequestDto extends createZodDto(startRunRequestSchema) {}
