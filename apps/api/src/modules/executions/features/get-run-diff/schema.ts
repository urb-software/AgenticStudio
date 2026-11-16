import { RUN_DIFF_PATH_MAX_LENGTH } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { runDiffScopeSchema } from '../../contracts/http/run-diff-response.js';

/** `GET /api/runs/:runId/diff` query (Issue #144): which diff. */
export const getRunDiffQuerySchema = z.strictObject({ scope: runDiffScopeSchema });

export class GetRunDiffQueryDto extends createZodDto(getRunDiffQuerySchema) {}

/** `GET /api/runs/:runId/diff/file` query (Issue #144): which diff, and the file's path. */
export const getRunDiffFileQuerySchema = z.strictObject({
  scope: runDiffScopeSchema,
  path: z.string().min(1).max(RUN_DIFF_PATH_MAX_LENGTH),
});

export class GetRunDiffFileQueryDto extends createZodDto(getRunDiffFileQuerySchema) {}
