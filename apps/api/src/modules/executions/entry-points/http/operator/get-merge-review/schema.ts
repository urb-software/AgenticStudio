import { RUN_DIFF_FILE_STATUSES, RUN_DIFF_PATH_MAX_LENGTH } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MERGE_REVIEW_STATES } from '../../../../domain/value-objects/merge-review-state.js';

export const getMergeReviewFileQuerySchema = z.strictObject({
  path: z.string().min(1).max(RUN_DIFF_PATH_MAX_LENGTH),
});

export class GetMergeReviewFileQueryDto extends createZodDto(getMergeReviewFileQuerySchema) {}

/**
 * `cut`: a limit left the patch out. A binary file has none either. All text is the
 * repository's: plain text.
 */
export const mergeReviewFileSchema = z
  .object({
    path: z.string(),
    previousPath: z.string().optional(),
    status: z.enum(RUN_DIFF_FILE_STATUSES),
    binary: z.literal(true).optional(),
    cut: z.boolean(),
  })
  .meta({ id: 'MergeReviewFileSummary' });

export const mergeReviewFilePatchSchema = mergeReviewFileSchema
  .extend({ patch: z.string().optional() })
  .meta({ id: 'MergeReviewFile' });

export class MergeReviewFileDto extends createZodDto(mergeReviewFilePatchSchema) {}

/** What the Integration branch would gain from the Run branch, as Studio computed it. */
export const mergeReviewResponseSchema = z
  .object({
    state: z.enum(MERGE_REVIEW_STATES),
    runCommit: z.string().optional(),
    integrationCommit: z.string().optional(),
    files: z.array(mergeReviewFileSchema),
    truncated: z.boolean(),
    failure: z.string().optional(),
  })
  .meta({ id: 'MergeReview' });

export class MergeReviewDto extends createZodDto(mergeReviewResponseSchema) {}
