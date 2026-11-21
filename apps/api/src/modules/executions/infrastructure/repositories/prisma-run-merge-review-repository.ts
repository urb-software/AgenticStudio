import { Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DATABASE_CLIENT } from '../../../../platform/database/database.module.js';
import { RunMergeReview } from '../../domain/entities/run-merge-review.js';
import type { RunMergeReviewRepository } from '../../domain/repositories/run-merge-review-repository.js';
import { RUN_DIFF_FILE_STATUSES } from '../../domain/value-objects/run-diff-file-status.js';
import { STORED_MERGE_REVIEW_STATES } from '../../domain/value-objects/merge-review-state.js';
import type { Executor } from './executor.js';

const storedFilesSchema = z.array(
  z.object({
    path: z.string(),
    previousPath: z.string().optional(),
    status: z.enum(RUN_DIFF_FILE_STATUSES),
    binary: z.literal(true).optional(),
    patch: z.string().optional(),
    cut: z.boolean(),
  }),
);

const storedStateSchema = z.enum(STORED_MERGE_REVIEW_STATES);

/**
 * The conditional writes are single statements: the claim and the finish are decided by the row,
 * so concurrent requests and a late result cannot overwrite each other.
 */
@Injectable()
export class PrismaRunMergeReviewRepository implements RunMergeReviewRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: Executor) {}

  async find(runId: string): Promise<RunMergeReview | null> {
    const row = await this.db.runMergeReview.findUnique({ where: { runId } });
    if (!row) return null;
    return RunMergeReview.restore({
      runId: row.runId,
      state: storedStateSchema.parse(row.state),
      runCommit: row.runCommit,
      integrationCommit: row.integrationCommit,
      files: storedFilesSchema.parse(row.files),
      truncated: row.truncated,
      failure: row.failure,
      requestedAt: row.requestedAt,
      completedAt: row.completedAt,
    });
  }

  async claim(review: RunMergeReview, staleBefore: Date): Promise<boolean> {
    const claimed = await this.db.$executeRaw`
      INSERT INTO run_merge_reviews (run_id, state, files, truncated, requested_at)
      VALUES (${review.runId}::uuid, 'preparing', '[]'::jsonb, false, ${review.requestedAt})
      ON CONFLICT (run_id) DO UPDATE SET
        state = 'preparing', run_commit = NULL, integration_commit = NULL, files = '[]'::jsonb,
        truncated = false, failure = NULL, requested_at = EXCLUDED.requested_at,
        completed_at = NULL
      WHERE run_merge_reviews.state <> 'preparing' OR run_merge_reviews.requested_at < ${staleBefore}`;
    return claimed === 1;
  }

  async finish(review: RunMergeReview): Promise<boolean> {
    const { count } = await this.db.runMergeReview.updateMany({
      where: { runId: review.runId, state: 'preparing', requestedAt: review.requestedAt },
      data: {
        state: review.storedState,
        runCommit: review.runCommit,
        integrationCommit: review.integrationCommit,
        files: review.files.map((file) => file.toData()) as unknown as Prisma.InputJsonValue,
        truncated: review.truncated,
        failure: review.failure,
        completedAt: review.completedAt,
      },
    });
    return count === 1;
  }
}
