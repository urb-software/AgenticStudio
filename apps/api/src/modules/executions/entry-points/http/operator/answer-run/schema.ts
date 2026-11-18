import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RunConversation } from '../../../../domain/value-objects/run-conversation.js';

export const answerRunRequestSchema = z
  .strictObject({
    text: z
      .string()
      .trim()
      .min(1, { error: 'Enter an answer.' })
      .max(RunConversation.ANSWER_MAX_LENGTH, {
        error: `Use at most ${RunConversation.ANSWER_MAX_LENGTH} characters.`,
      }),
  })
  .meta({ id: 'AnswerRunRequest' });

export class AnswerRunRequestDto extends createZodDto(answerRunRequestSchema) {}
