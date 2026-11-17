import {
  RUN_DIFF_FILE_STATUSES,
  RUN_DIFF_PATH_MAX_LENGTH,
  RUN_DIFF_SCOPES,
} from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Which diff of a Run (Issue #144): the whole Run, or since the previous result. */
export const runDiffScopeSchema = z.enum(RUN_DIFF_SCOPES);

/** `GET /api/runs/:runId/diff` query (Issue #144): which diff. */
export const getRunDiffQuerySchema = z.strictObject({ scope: runDiffScopeSchema });

export class GetRunDiffQueryDto extends createZodDto(getRunDiffQuerySchema) {}

/** `GET /api/runs/:runId/diff/file` query (Issue #144): which diff, and the file's path. */
export const getRunDiffFileQuerySchema = z.strictObject({
  scope: runDiffScopeSchema,
  path: z.string().min(1).max(RUN_DIFF_PATH_MAX_LENGTH),
});

export class GetRunDiffFileQueryDto extends createZodDto(getRunDiffFileQuerySchema) {}

/**
 * One file of `GET /api/runs/:runId/diff/file` (Issue #144): its path (and the previous one of a
 * rename), status, and its unified diff (`patch`, Git's text, redacted like the log), loaded
 * per file. `binary` and `tooLarge` files have no patch; a file listed after the diff reached
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

/** One changed file in `GET /api/runs/:runId/diff`: the file without its patch, with its counts. */
export const runDiffFileSummarySchema = runDiffFileResponseSchema
  .omit({ patch: true })
  .extend({ additions: z.int().min(0), deletions: z.int().min(0) })
  .meta({ id: 'RunDiffFileSummary' });

/**
 * `GET /api/runs/:runId/diff?scope=run|last` (Issue #144): the commit the diff starts from,
 * whether it includes changes that are not pushed, the files, and whether a limit left content
 * or files out. A diff the agent worker could not compute has no base commit, no pushed state
 * and no files, and says why (`unavailableReason`). All text is the repository's and the
 * agent's: plain text.
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
