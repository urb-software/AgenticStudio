import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `GET /api/runs/:runId/events/stream` query (Issue #99): the seq to start after. Without it,
 * the `Last-Event-ID` header (sent by a reconnecting EventSource) is used, else 0.
 */
export const streamRunEventsQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
});

export class StreamRunEventsQueryDto extends createZodDto(streamRunEventsQuerySchema) {}
