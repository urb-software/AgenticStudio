import { PREVIEW_EVENTS_DEFAULT_LIMIT, PREVIEW_EVENTS_MAX_LIMIT } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const getPreviewBuildEventsQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).max(2_147_483_647).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PREVIEW_EVENTS_MAX_LIMIT)
    .default(PREVIEW_EVENTS_DEFAULT_LIMIT),
});

export class GetPreviewBuildEventsQueryDto extends createZodDto(getPreviewBuildEventsQuerySchema) {}
