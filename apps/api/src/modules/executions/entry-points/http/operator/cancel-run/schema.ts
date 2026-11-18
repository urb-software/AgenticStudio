import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const cancelRunResponseSchema = z
  .strictObject({
    outcome: z.enum(['cancelled', 'cancel_requested']),
  })
  .meta({ id: 'CancelRunResponse' });

export class CancelRunResponseDto extends createZodDto(cancelRunResponseSchema) {}
