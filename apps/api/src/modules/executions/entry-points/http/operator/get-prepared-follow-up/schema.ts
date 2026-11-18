import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { followUpSourceSchema } from '../../shared/run-response.js';

/** The text comes from CI jobs: the page shows it as plain text and never interprets it. */
export const preparedFollowUpResponseSchema = z
  .object({
    source: followUpSourceSchema,
    text: z.string(),
    checks: z.array(
      z
        .object({
          name: z.string(),
          url: z.url(),
          logAvailable: z.boolean(),
          section: z.string(),
        })
        .meta({ id: 'PreparedFollowUpCheck' }),
    ),
  })
  .meta({ id: 'PreparedFollowUp' });

export class PreparedFollowUpResponseDto extends createZodDto(preparedFollowUpResponseSchema) {}
