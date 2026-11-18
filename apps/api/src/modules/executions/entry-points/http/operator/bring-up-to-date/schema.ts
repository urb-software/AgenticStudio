import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { FollowUpText } from '../../../../domain/value-objects/follow-up-text.js';

export const bringUpToDateRequestSchema = z
  .strictObject({
    note: z
      .string()
      .trim()
      .max(FollowUpText.MAX_LENGTH, { error: `Use at most ${FollowUpText.MAX_LENGTH} characters.` })
      .optional(),
  })
  .meta({ id: 'BringUpToDateRequest' });

export class BringUpToDateRequestDto extends createZodDto(bringUpToDateRequestSchema) {}
