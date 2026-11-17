import { Prisma } from '@agentic-studio/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DATABASE_CLIENT } from '../../../../platform/database/database.module.js';
import {
  ReviewComments,
  type ReviewCommentsSnapshot,
} from '../../domain/entities/review-comments.js';
import type { ReviewCommentRepository } from '../../domain/repositories/review-comment-repository.js';
import type { ReviewCommentScope } from '../../domain/value-objects/review-comments.js';
import type { Executor } from './executor.js';
import { commentsSchema } from './review-comment-json.js';

/**
 * PostgreSQL adapter of {@link ReviewCommentRepository} (Issue #146): the Run's
 * `run_review_comment_sets` row. A stored set that no longer matches the shared contract is left
 * out (and logged) rather than shown.
 */
@Injectable()
export class PrismaReviewCommentRepository implements ReviewCommentRepository {
  private readonly logger = new Logger('ReviewComments');

  constructor(@Inject(DATABASE_CLIENT) private readonly db: Executor) {}

  async find(runId: string): Promise<ReviewComments | null> {
    const snapshot = await this.findSnapshot(runId);
    return snapshot === null ? null : ReviewComments.restore(snapshot);
  }

  async findSnapshot(runId: string): Promise<ReviewCommentsSnapshot | null> {
    const row = await this.db.runReviewCommentSet.findUnique({ where: { runId } });
    if (!row) return null;
    const comments = commentsSchema.safeParse(row.comments);
    if (!comments.success) {
      // A stored set that does not validate is no loaded set.
      this.logger.warn(`The stored review comments of run ${runId} are not valid: left out.`);
      return null;
    }
    return {
      // The CHECK constraint fixes the scope.
      scope: row.scope as ReviewCommentScope,
      comments: comments.data,
      truncated: row.truncated,
      loadedAt: row.loadedAt,
    };
  }

  async replace(runId: string, set: ReviewComments): Promise<void> {
    const comments = set.comments as unknown as Prisma.InputJsonValue;
    // The latest load replaces the earlier one.
    await this.db.runReviewCommentSet.upsert({
      where: { runId },
      create: {
        runId,
        scope: set.scope,
        comments,
        truncated: set.truncated,
        loadedAt: set.loadedAt,
      },
      update: { scope: set.scope, comments, truncated: set.truncated, loadedAt: set.loadedAt },
    });
  }

  async discard(runId: string): Promise<void> {
    await this.db.runReviewCommentSet.deleteMany({ where: { runId } });
  }
}
