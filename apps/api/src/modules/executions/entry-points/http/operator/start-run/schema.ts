import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PROVIDERS } from '../../../../domain/value-objects/provider.js';
import { TASK_MAX_LENGTH } from '../../../../domain/value-objects/task.js';

/**
 * Counted in UTF-16 code units; PostgreSQL VARCHAR(20000) counts characters, so a
 * valid Task always fits.
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
