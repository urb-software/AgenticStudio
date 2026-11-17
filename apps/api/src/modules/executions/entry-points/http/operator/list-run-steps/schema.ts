import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** One reported Run step in `GET /api/runs/:runId/steps` (Issue #99). */
export const runStepSchema = z
  .object({
    /** 1, 2, … in report order; matches the `stepIndex` of the step's log events. */
    index: z.int().min(1),
    kind: z.enum(['start', 'resume']),
    outcome: z.enum(['done', 'needs_input']),
    summary: z.string(),
    /** The agent's account of the checks it ran. */
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
