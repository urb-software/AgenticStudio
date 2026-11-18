import {
  RUN_DIFF_FILE_STATUSES,
  RUN_DIFF_PATH_MAX_LENGTH,
  RUN_DIFF_SCOPES,
} from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const runDiffScopeSchema = z.enum(RUN_DIFF_SCOPES);

export const getRunDiffQuerySchema = z.strictObject({ scope: runDiffScopeSchema });

export class GetRunDiffQueryDto extends createZodDto(getRunDiffQuerySchema) {}

export const getRunDiffFileQuerySchema = z.strictObject({
  scope: runDiffScopeSchema,
  path: z.string().min(1).max(RUN_DIFF_PATH_MAX_LENGTH),
});

export class GetRunDiffFileQueryDto extends createZodDto(getRunDiffFileQuerySchema) {}

/**
 * `binary` and `tooLarge` files have no patch; a file listed after the diff reached
 * its total limit has none either (the diff is `truncated`).
 */
export const runDiffFileResponseSchema = z
  .object({
    path: z.string(),
    previousPath: z.string().optional(),
    status: z.enum(RUN_DIFF_FILE_STATUSES),
    patch: z.string().optional(),
    tooLarge: z.literal(true).optional(),
    binary: z.literal(true).optional(),
  })
  .meta({ id: 'RunDiffFile' });

export class RunDiffFileDto extends createZodDto(runDiffFileResponseSchema) {}

export const runDiffFileSummarySchema = runDiffFileResponseSchema
  .omit({ patch: true })
  .extend({ additions: z.int().min(0), deletions: z.int().min(0) })
  .meta({ id: 'RunDiffFileSummary' });

/**
 * A diff the agent worker could not compute has no base commit, pushed state or files, and says
 * why. All text is the repository's and the agent's: plain text.
 */
export const runDiffResponseSchema = z
  .object({
    scope: runDiffScopeSchema,
    baseCommit: z.string().optional(),
    includesUnpushed: z.boolean().optional(),
    truncated: z.boolean(),
    files: z.array(runDiffFileSummarySchema),
    unavailableReason: z.string().optional(),
  })
  .meta({ id: 'RunDiff' });

export class RunDiffDto extends createZodDto(runDiffResponseSchema) {}
