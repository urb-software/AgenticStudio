import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import type { ReviewCommentScope, ReviewComments } from '../../domain/entities/review-comments.js';
import type { ReviewCommentRepository } from '../../domain/repositories/review-comment-repository.js';
import { commentsSchema } from './review-comment-json.js';

const OPEN = ['requested', 'claimed'];

/**
 * PostgreSQL adapter of {@link ReviewCommentRepository} (Issue #146): the Run's
 * `run_review_comment_sets` row, and the state of its latest `review_comments` lookup. A stored
 * set that no longer matches the shared contract is left out (and logged) rather than shown.
 */
@Injectable()
export class PrismaReviewCommentRepository implements ReviewCommentRepository {
  private readonly logger = new Logger('ReviewComments');

  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async findReviewComments(runId: string): Promise<ReviewComments> {
    const [row, open, latest] = await Promise.all([
      this.db.runReviewCommentSet.findUnique({ where: { runId } }),
      this.db.runLookup.findFirst({
        where: { runId, kind: 'review_comments', status: { in: OPEN } },
        select: { error: true },
      }),
      this.db.runLookup.findFirst({
        where: { runId, kind: 'review_comments' },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        select: { status: true, error: true },
      }),
    ]);
    let set: ReviewComments['set'] = null;
    if (row) {
      const comments = commentsSchema.safeParse(row.comments);
      if (comments.success) {
        set = {
          // The CHECK constraint fixes the scope.
          scope: row.scope as ReviewCommentScope,
          comments: comments.data,
          truncated: row.truncated,
          loadedAt: row.loadedAt,
        };
      } else {
        this.logger.warn(`The stored review comments of run ${runId} are not valid: left out.`);
      }
    }
    return {
      set,
      load: {
        loading: open !== null,
        error: open?.error ?? (latest?.status === 'failed' ? latest.error : null),
      },
    };
  }
}
