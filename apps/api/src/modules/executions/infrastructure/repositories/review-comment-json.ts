import { reviewCommentSchema } from '@agentic-studio/contracts';
import { z } from 'zod';

/** What a `run_review_comment_sets.comments` value holds, checked on every read (Issue #146). */
export const commentsSchema = z.array(reviewCommentSchema);
