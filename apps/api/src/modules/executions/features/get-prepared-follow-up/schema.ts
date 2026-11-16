import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { followUpSourceSchema } from '../../contracts/http/run-response.js';

/**
 * `GET /api/runs/:runId/pull-request/failing-checks/prepared` answer (Issue #145): the Follow-up
 * Studio prepared from the failing Pull request checks, for the operator to review: the whole
 * `text`, and the parts it was built from. Each check's `section` is exactly the part of `text`
 * that belongs to it, so the page can leave it out when the operator deselects the check.
 * The text comes from CI jobs: the page shows it as plain text and never interprets it.
 */
export const preparedFollowUpResponseSchema = z
  .object({
    source: followUpSourceSchema,
    text: z.string(),
    checks: z.array(
      z
        .object({
          name: z.string(),
          url: z.url(),
          /** Whether the check's log excerpt is in the text; false: only its name, link and why. */
          logAvailable: z.boolean(),
          section: z.string(),
        })
        .meta({ id: 'PreparedFollowUpCheck' }),
    ),
  })
  .meta({ id: 'PreparedFollowUp' });

export class PreparedFollowUpResponseDto extends createZodDto(preparedFollowUpResponseSchema) {}
