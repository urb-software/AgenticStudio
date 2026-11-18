import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const runsSummaryResponseSchema = z
  .object({
    running: z.int().min(0),
    waiting: z.int().min(0),
  })
  .meta({ id: 'RunsSummary' });

export class RunsSummaryResponseDto extends createZodDto(runsSummaryResponseSchema) {}
