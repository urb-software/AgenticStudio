import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const streamRunEventsQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
});

export class StreamRunEventsQueryDto extends createZodDto(streamRunEventsQuerySchema) {}
