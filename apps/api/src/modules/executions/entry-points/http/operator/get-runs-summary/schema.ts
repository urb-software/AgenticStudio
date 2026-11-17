import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `GET /api/runs/summary` answer (Issue #115): the Runs under way (queued, preparing or
 * running) and the Runs waiting for the operator, across all projects.
 */
export const runsSummaryResponseSchema = z
  .object({
    running: z.int().min(0),
    waiting: z.int().min(0),
  })
  .meta({ id: 'RunsSummary' });

export class RunsSummaryResponseDto extends createZodDto(runsSummaryResponseSchema) {}
