import { Prisma } from '@agentic-studio/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DATABASE_CLIENT } from '../../../../platform/database/database.module.js';
import { ReviewComments } from '../../domain/entities/review-comments.js';
import { type ReviewCommentsData } from '../../domain/entities/review-comments-data.js';
import type { ReviewCommentRepository } from '../../domain/repositories/review-comment-repository.js';
import type { ReviewCommentScope } from '../../domain/value-objects/review-comment-scope.js';
import type { Executor } from './executor.js';
import { commentsSchema } from './review-comment-json.js';

@Injectable()
export class PrismaReviewCommentRepository implements ReviewCommentRepository {
  private readonly logger = new Logger('ReviewComments');

  constructor(@Inject(DATABASE_CLIENT) private readonly db: Executor) {}

  async find(runId: string): Promise<ReviewComments | null> {
    const data = await this.read(runId);
    return data === null ? null : ReviewComments.restore(data);
  }

  private async read(runId: string): Promise<ReviewCommentsData | null> {
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
    const comments = set.comments.map((comment) =>
      comment.toData(),
    ) as unknown as Prisma.InputJsonValue;
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
