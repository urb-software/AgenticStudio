import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { FOLLOW_UP_MAX_LENGTH } from '../../../../domain/value-objects/follow-up.js';

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
