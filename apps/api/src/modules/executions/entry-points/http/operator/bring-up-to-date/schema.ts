import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RunConversation } from '../../../../domain/value-objects/run-conversation.js';

export const bringUpToDateRequestSchema = z
  .strictObject({
    note: z
      .string()
      .trim()
      .max(RunConversation.FOLLOW_UP_MAX_LENGTH, {
        error: `Use at most ${RunConversation.FOLLOW_UP_MAX_LENGTH} characters.`,
      })
      .optional(),
  })
  .meta({ id: 'BringUpToDateRequest' });

export class BringUpToDateRequestDto extends createZodDto(bringUpToDateRequestSchema) {}
