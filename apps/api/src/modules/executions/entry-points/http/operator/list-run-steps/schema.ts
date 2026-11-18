import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const runStepSchema = z
  .object({
    index: z.int().min(1),
    kind: z.enum(['start', 'resume']),
    outcome: z.enum(['done', 'needs_input']),
    summary: z.string(),
    checks: z.array(
      z.object({
        name: z.string(),
        result: z.enum(['passed', 'failed', 'not_run']),
        detail: z.string().optional(),
      }),
    ),
    reportedAt: z.iso.datetime(),
  })
  .meta({ id: 'RunStep' });

export const runStepListSchema = z
  .object({ steps: z.array(runStepSchema) })
  .meta({ id: 'RunStepList' });

export class RunStepListDto extends createZodDto(runStepListSchema) {}
