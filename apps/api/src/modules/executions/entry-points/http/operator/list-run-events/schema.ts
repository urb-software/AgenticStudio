import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { RUN_EVENTS_PAGE } from '../../../../application/features/list-run-events/handler.js';

/** `GET /api/runs/:runId/events` query (Issue #99): the seq to start after, and the page size. */
export const listRunEventsQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).max(2_147_483_647).default(0),
  limit: z.coerce.number().int().min(1).max(RUN_EVENTS_PAGE.max).default(RUN_EVENTS_PAGE.default),
});

export class ListRunEventsQueryDto extends createZodDto(listRunEventsQuerySchema) {}
