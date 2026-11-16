import { RUN_DIFF_FILE_STATUSES, RUN_DIFF_SCOPES } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Which diff of a Run (Issue #144): the whole Run, or since the previous result. */
export const runDiffScopeSchema = z.enum(RUN_DIFF_SCOPES);

/**
 * One changed file in `GET /api/runs/:runId/diff` (Issue #144): its path (and the previous one
 * of a rename), status and line counts. `binary` and `tooLarge` files have no patch; a file
 * listed after the diff reached its total limit has none either (the diff is `truncated`).
 */
export const runDiffFileSummarySchema = z
  .object({
    path: z.string(),
    previousPath: z.string().optional(),
    status: z.enum(RUN_DIFF_FILE_STATUSES),
    additions: z.int().min(0),
    deletions: z.int().min(0),
    binary: z.literal(true).optional(),
    tooLarge: z.literal(true).optional(),
  })
  .meta({ id: 'RunDiffFileSummary' });

/**
 * `GET /api/runs/:runId/diff?scope=run|last` (Issue #144): the commit the diff starts from,
 * whether it includes changes that are not pushed, the files, and whether a limit left content
 * or files out. A diff the agent worker could not compute has no base commit and no files, and
 * says why (`unavailableReason`). All text is the repository's and the agent's: plain text.
 */
export const runDiffResponseSchema = z
  .object({
    scope: runDiffScopeSchema,
    baseCommit: z.string().optional(),
    includesUnpushed: z.boolean(),
    truncated: z.boolean(),
    files: z.array(runDiffFileSummarySchema),
    unavailableReason: z.string().optional(),
  })
  .meta({ id: 'RunDiff' });

export class RunDiffDto extends createZodDto(runDiffResponseSchema) {}

/**
 * `GET /api/runs/:runId/diff/file?scope=…&path=…` (Issue #144): one file of a diff with its
 * unified diff (`patch`, Git's text, redacted like the log), loaded per file.
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
