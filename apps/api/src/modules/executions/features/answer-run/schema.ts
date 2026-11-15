import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ANSWER_MAX_LENGTH } from '../../domain/entities/run.js';

/**
 * `POST /api/runs/:runId/answer` body (Issue #103): the operator's answer, trimmed, then 1–10 000
 * characters. Closed: an unknown field is an error. An invalid body is a 422 (the agreed
 * contract), so the endpoint validates it.
 */
export const answerRunRequestSchema = z
  .strictObject({
    text: z
      .string()
      .trim()
      .min(1, { error: 'Enter an answer.' })
      .max(ANSWER_MAX_LENGTH, { error: `Use at most ${ANSWER_MAX_LENGTH} characters.` }),
  })
  .meta({ id: 'AnswerRunRequest' });

export class AnswerRunRequestDto extends createZodDto(answerRunRequestSchema) {}
